import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { readdir, rm, rmdir, utimes } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { MAX_OUTPUT_BYTES, OutputBuffer } from "./output.ts";
import { artifactDirectory } from "../artifacts.ts";

const WINDOWS = process.platform === "win32";
const BINARY_NAME = WINDOWS ? "pi-prime-terminal.exe" : "pi-prime-terminal";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEV_BINARY = join(MODULE_DIR, "native", "target", "release", BINARY_NAME);
const INSTALLED_BINARY = join(MODULE_DIR, "..", "..", "bin", BINARY_NAME);
const DEFAULT_OUTPUT_TOKENS = 8_000;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, WINDOWS ? constants.F_OK : constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
}

export function resolveBinaryPath(): string {
  const override = process.env.PI_PRIME_TERMINAL_BIN?.trim();
  if (override) {
    if (isExecutable(override)) return resolve(override);
    throw new Error(`PI_PRIME_TERMINAL_BIN does not exist or is not executable: ${resolve(override)}`);
  }
  if (isExecutable(INSTALLED_BINARY)) return INSTALLED_BINARY;
  if (isExecutable(DEV_BINARY)) return DEV_BINARY;
  throw new Error(`Missing executable native helper (${BINARY_NAME}).`);
}
const DEFAULT_WAIT_MS = 10_000;
export const MAX_WAIT_MS = 300_000;
const DEFAULT_COLLECT_MS = 30_000;
const MAX_SESSIONS = 64;

type Request =
  | { op: "spawn"; session_id: number; cmd: string; cwd: string; tty: boolean }
  | { op: "write"; session_id: number; chars: string }
  | { op: "poll" | "close"; session_id: number };

interface Poll {
  head: string;
  tail: string;
  omitted_bytes: number;
  original_bytes: number;
  exit_code: number | null;
  failure: string | null;
  output_closed: boolean;
  log_available: boolean;
  log_truncated?: boolean;
}

export type TerminalOutput = {
  wall_time_seconds: number;
  output: string;
  session_id?: number;
  exit_code?: number;
  original_token_count: number;
  truncated?: boolean;
  full_output_path?: string;
  log_truncated?: boolean;
  cancelled?: boolean;
  interrupt_sent?: boolean;
  termination_reason?: "ctrl_c";
};

export type TerminalSessionInfo = {
  session_id: number;
  command: string;
  cwd: string;
  tty: boolean;
  status: "running" | "exited";
  exit_code: number | null;
};
export type TerminalCloseStatus = "termination_requested" | "root_exited" | "already_closed" | "unconfirmed";

interface Session {
  id: number;
  cmd: string;
  tty: boolean;
  cwd: string;
  busy: boolean;
  pendingInputs: number;
  pendingInterrupts: number;
  lastUsed: number;
  exitCode: number | null;
  exitDeadline?: number;
  terminationReason?: "ctrl_c";
  logPath: string;
  keepLog: boolean;
  logTruncated?: boolean;
  decoder: TextDecoder;
  waiters: Set<() => void>;
}

export function shellPath(): string {
  const executable = WINDOWS ? "pwsh.exe" : "bash";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(WINDOWS ? dir.replace(/^"|"$/g, "") : dir, executable);
    if (isAbsolute(path) && isExecutable(path)) return path;
  }
  throw new Error(WINDOWS
    ? "pi-prime terminal requires PowerShell 7 (pwsh.exe on PATH). Install via `winget install Microsoft.PowerShell`."
    : "pi-prime terminal requires bash (bash on PATH).");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error("cancelled")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** A cancelled waiter must never release its still-active predecessor. */
async function withLock<T>(locks: Map<number, Promise<void>>, id: number, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(id, current);
  try {
    await abortable(previous, signal);
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
    void current.then(() => { if (locks.get(id) === current) locks.delete(id); });
  }
}

export class TerminalRuntime {
  private readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly sessions = new Map<number, Session>();
  // Keep closed IDs reserved for the lifetime of this runtime.
  private readonly usedIds = new Set<number>();
  private readonly outputDirectory: string;
  private readonly retainedLogs = new Set<string>();
  private readonly completed = new Map<number, { exitCode: number | null; terminationReason?: "ctrl_c"; fullOutputPath?: string; logTruncated?: boolean }>();
  private readonly locks = new Map<number, Promise<void>>();
  private readonly requests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private requestId = 0;
  private stopped = false;
  private failure?: Error;
  private shutdown?: Promise<void>;

  get failed(): boolean { return this.failure !== undefined; }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => b.lastUsed - a.lastUsed).map(session => ({
      session_id: session.id, command: session.cmd.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200),
      cwd: session.cwd, tty: session.tty, status: session.exitCode === null ? "running" : "exited", exit_code: session.exitCode,
    }));
  }

  private unknownSession(id: number): Error {
    const sessions = this.list();
    const shown = sessions.slice(0, 8);
    return new Error(`Unknown terminal session ${id}. ${shown.length
      ? `Recent sessions:\n${shown.map(s => `${s.session_id} (${s.status}${s.tty ? ", TTY" : ""}): ${s.command}`).join("\n")}`
      : "No terminal sessions are available."}\nUse terminal_sessions to list sessions; use exec_command to start a new command.`);
  }

  constructor() {
    const binary = resolveBinaryPath();
    const shell = shellPath();
    this.outputDirectory = artifactDirectory("terminal");
    // WSL ps sees one row on pipe stdio. Supply height only, keeping command widths unbounded.
    this.child = spawn(binary, [shell, this.outputDirectory], {
      stdio: "pipe", windowsHide: true,
      env: { ...process.env, LINES: "30", ...(WINDOWS ? {
        WSLENV: [process.env.WSLENV, "LINES/u"].filter(Boolean).join(":"),
        // Python 3.13's Windows pyrepl loses non-BMP input. Limit this workaround
        // to terminal children and respect an explicitly selected REPL.
        PYTHON_BASIC_REPL: process.env.PYTHON_BASIC_REPL ?? "1",
      } : {}) },
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      rejectReady(error);
      for (const pending of this.requests.values()) pending.reject(error);
      this.requests.clear();
      for (const session of this.sessions.values()) this.notify(session.id);
      if (!this.stopped) {
        this.child.kill();
        void this.dispose().catch(error => console.warn("[pi-prime] Terminal cleanup failed:", error));
      }
    };
    const timer = setTimeout(() => fail(new Error("pi-prime terminal native startup timed out")), 10_000);
    void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.event === "ready") resolveReady();
        else if (message.event === "output") {
          const session = this.sessions.get(message.session_id);
          if (session && message.exit_code !== undefined) session.exitCode = message.exit_code;
          this.notify(message.session_id);
        } else {
          const pending = this.requests.get(message.id);
          if (!pending) return;
          this.requests.delete(message.id);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
        }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    let stderr = "";
    this.child.stderr.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-4096); });
    this.child.on("error", fail);
    this.child.on("close", code => {
      const error = new Error(`pi-prime terminal native process exited (${code})${stderr ? `: ${stderr.trim()}` : ""}`);
      fail(error);
      lines.close();
    });
    this.child.stdin.on("error", fail);
  }

  private notify(id: number): void {
    for (const wake of this.sessions.get(id)?.waiters ?? []) wake();
  }

  private async request<T>(operation: Request): Promise<T> {
    await this.ready;
    if (this.stopped || this.failure) throw this.failure ?? new Error("terminal session has ended");
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, ...operation })}\n`, error => {
        if (error) { this.requests.delete(id); reject(error); }
      });
    });
  }

  private async open(cmd: string, cwd: string, tty: boolean, signal?: AbortSignal): Promise<Session> {
    // ID zero is reserved for allocation; waits on different sessions remain parallel.
    return withLock(this.locks, 0, signal, async () => {
      if (this.sessions.size >= MAX_SESSIONS) {
        const victim = [...this.sessions.values()]
          .filter(session => session.exitCode !== null && !session.busy && !this.locks.has(session.id))
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!victim) throw new Error(`All ${MAX_SESSIONS} terminal slots are in use. Use terminal_sessions to inspect them and close a selected session to free a slot. The command did not start.`);
        // A yielded command may have finished without anyone polling its output.
        victim.keepLog = true;
        this.retainedLogs.add(victim.logPath);
        await this.close(victim.id);
      }
      if (this.usedIds.size === 900_000) throw new Error("terminal session IDs exhausted; reload to start a new runtime");
      let id: number;
      do { id = randomInt(100_000, 1_000_000); } while (this.usedIds.has(id));
      this.usedIds.add(id);
      await this.request({ op: "spawn", session_id: id, cmd, cwd, tty });
      const session: Session = {
        id, cmd, tty, cwd, busy: true, pendingInputs: 0, pendingInterrupts: 0, lastUsed: performance.now(), exitCode: null,
        logPath: join(this.outputDirectory, `${id}.log`), keepLog: false,
        decoder: new TextDecoder(), waiters: new Set(),
      };
      this.sessions.set(id, session);
      return session;
    });
  }

  private wait(session: Session, duration: number, signal?: AbortSignal): { promise: Promise<void>; stop: () => void } {
    let finish!: () => void;
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>(resolve => { finish = resolve; });
    const stop = () => {
      clearTimeout(timer);
      session.waiters.delete(stop);
      signal?.removeEventListener("abort", stop);
      finish();
    };
    session.waiters.add(stop);
    signal?.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, Math.max(0, duration));
    if (signal?.aborted) stop();
    return { promise, stop };
  }

  private async collect(session: Session, started: number, yieldMs: number, maxTokens: number | undefined, signal: AbortSignal | undefined, options: {
    settleOutput: boolean; polling: boolean; interruptSent?: boolean; update?: (output: TerminalOutput) => void;
  }): Promise<TerminalOutput> {
    const { settleOutput, polling, interruptSent, update } = options;
    const output = new OutputBuffer(Math.min(MAX_OUTPUT_BYTES, (maxTokens ?? DEFAULT_OUTPUT_TOKENS) * 4));
    const deadline = performance.now() + yieldMs;
    let quietDeadline: number | undefined;
    let lastUpdate = -Infinity;
    let updatePending = false;
    let logAvailable = false;
    const result = ({ exitCode, cancelled, final = true }: { exitCode?: number; cancelled?: boolean; final?: boolean } = {}): TerminalOutput => {
      // A cancelled codemode wait may have already drained the native buffer.
      // Retain that session's log on final return, without letting transient streaming updates pin logs for short commands.
      if (final && logAvailable && (output.truncated || cancelled || (exitCode === undefined && output.originalBytes > 0))) {
        session.keepLog = true;
        this.retainedLogs.add(session.logPath);
      }
      let text = output.text;
      if (session.tty) text = text.replace(/\n(?:[ \t]*\n){2,}$/, "\n");
      return {
        wall_time_seconds: Math.round((performance.now() - started) / 100) / 10,
        output: text,
        ...(exitCode === undefined ? { session_id: session.id } : { exit_code: exitCode }),
        original_token_count: Math.ceil(output.originalBytes / 4),
        ...(output.truncated ? { truncated: true } : {}),
        ...(session.keepLog && logAvailable ? { full_output_path: session.logPath } : {}),
        ...(session.keepLog && session.logTruncated ? { log_truncated: true } : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...(interruptSent ? { interrupt_sent: true } : {}),
        ...(exitCode !== undefined && session.terminationReason ? { termination_reason: session.terminationReason } : {}),
      };
    };
    while (true) {
      if (signal?.aborted) return result({ cancelled: true });
      if (this.sessions.get(session.id) !== session) return this.completedResult(session.id, started);
      // Subscribe before polling so an output notification cannot be lost
      // between draining the native buffer and starting the wait.
      const waitUntil = Math.min(deadline, session.exitDeadline ?? Infinity, quietDeadline ?? Infinity, update && updatePending ? lastUpdate + 100 : Infinity);
      const wait = this.wait(session, waitUntil - performance.now(), signal);
      try {
        const poll = await this.request<Poll>({ op: "poll", session_id: session.id });
        logAvailable = poll.log_available;
        session.logTruncated ||= poll.log_truncated;
        const head = Buffer.from(poll.head, "base64");
        const tail = Buffer.from(poll.tail, "base64");
        output.originalBytes += poll.original_bytes;
        output.append(Buffer.from(session.decoder.decode(head, { stream: true })));
        if (poll.omitted_bytes) {
          output.omittedBytes += poll.omitted_bytes;
          session.decoder = new TextDecoder();
          let start = 0;
          while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
          output.append(Buffer.from(session.decoder.decode(tail.subarray(start), { stream: true })));
        } else output.append(Buffer.from(session.decoder.decode(tail, { stream: true })));
        session.exitCode = poll.exit_code ?? session.exitCode;
        if (poll.failure) output.append(Buffer.from(`\n${poll.failure}`));
        if (signal?.aborted) return result({ cancelled: true });
        if (session.exitCode !== null) {
          session.exitDeadline ??= performance.now() + 50;
          if (poll.output_closed || performance.now() >= session.exitDeadline) {
            output.append(Buffer.from(session.decoder.decode()));
            const completed = result({ exitCode: session.exitCode });
            await this.close(session.id);
            return completed;
          }
        }
        const now = performance.now();
        // Screen controls alone are not a prompt. Settle only visible TTY output;
        // an explicit yield window still collects slow or multi-burst responses.
        if (settleOutput && poll.original_bytes > 0 && output.text.trim()) quietDeadline = now + 100;
        updatePending ||= poll.original_bytes > 0;
        if (update && updatePending && now - lastUpdate >= 100) {
          lastUpdate = now;
          updatePending = false;
          update(result({ final: false }));
        }
        if (now >= deadline || now >= (quietDeadline ?? Infinity) || session.pendingInterrupts > 0 || (polling && session.pendingInputs > 0) || signal?.aborted) return result({ cancelled: signal?.aborted });
        // Re-arm when the poll introduces an earlier exit, quiet or update deadline.
        if (waitUntil > Math.min(session.exitDeadline ?? Infinity, quietDeadline ?? Infinity, update && updatePending ? lastUpdate + 100 : Infinity)) continue;
        await wait.promise;
      } finally { wait.stop(); }
    }
  }

  /** An abort rejects with the signal's reason only before launch; afterwards it resolves with cancelled=true. */
  async exec(options: { cmd: string; cwd: string; tty?: boolean; yield_time_ms?: number; max_output_tokens?: number; signal?: AbortSignal; update?: (output: TerminalOutput) => void }): Promise<TerminalOutput> {
    const started = performance.now();
    const session = await this.open(options.cmd, options.cwd, options.tty ?? false, options.signal);
    try {
      options.update?.({
        wall_time_seconds: Math.round((performance.now() - started) / 100) / 10,
        output: "",
        session_id: session.id,
        original_token_count: 0,
      });
      return await withLock(this.locks, session.id, undefined, () => this.collect(session, started, Math.min(MAX_WAIT_MS, Math.max(0, options.yield_time_ms ?? DEFAULT_WAIT_MS)), options.max_output_tokens, options.signal, { settleOutput: session.tty && options.yield_time_ms === undefined, polling: true, update: options.update }));
    } finally { session.busy = false; session.lastUsed = performance.now(); }
  }

  /** An abort rejects with the signal's reason only before the session is reached; afterwards it resolves with cancelled=true. */
  async write(options: { session_id: number; chars?: string; interrupt?: boolean; yield_time_ms?: number; max_output_tokens?: number; signal?: AbortSignal; update?: (output: TerminalOutput) => void }): Promise<TerminalOutput> {
    const started = performance.now();
    options.signal?.throwIfAborted();
    if (options.interrupt && options.chars) throw new Error("Use interrupt=true without chars, or supply chars for input.");
    const chars = options.interrupt ? "\u0003" : options.chars ?? "";
    const session = this.sessions.get(options.session_id);
    if (!session) return this.completedResult(options.session_id, started, chars);
    const interrupt = chars === "\u0003";
    let pendingInput = chars.length > 0;
    // Input yields older pure polls; Ctrl+C also yields command-response waits.
    // Ticket counts preserve other queued inputs when one caller cancels.
    if (pendingInput) {
      session.pendingInputs++;
      if (interrupt) session.pendingInterrupts++;
      this.notify(session.id);
    }
    const withdraw = () => {
      if (!pendingInput) return;
      pendingInput = false;
      session.pendingInputs--;
      if (interrupt) session.pendingInterrupts--;
    };
    try {
      return await withLock(this.locks, session.id, options.signal, async () => {
        if (this.sessions.get(session.id) !== session) return this.completedResult(session.id, started, chars);
        withdraw();
        session.busy = true;
        session.lastUsed = performance.now();
        try {
          let interruptSent = false;
          if (chars) {
            const written = await this.request<boolean>({ op: "write", session_id: session.id, chars });
            interruptSent = interrupt && written;
            // Only pipe Ctrl+C confirms process-tree termination. A TTY may handle it and continue.
            if (interruptSent && !session.tty) session.terminationReason = "ctrl_c";
          }
          const yieldMs = Math.min(MAX_WAIT_MS, Math.max(0, options.yield_time_ms ?? (chars ? 250 : session.tty ? 1000 : DEFAULT_COLLECT_MS)));
          return await this.collect(session, started, yieldMs, options.max_output_tokens, options.signal, { settleOutput: session.tty && options.yield_time_ms === undefined, polling: !chars, interruptSent, update: options.update });
        } finally { session.busy = false; session.lastUsed = performance.now(); }
      });
    } finally { withdraw(); }
  }

  private completedResult(id: number, started: number, chars = ""): TerminalOutput {
    const completed = this.completed.get(id);
    if (!completed) throw this.unknownSession(id);
    const status = completed.exitCode === null ? "was closed" : `exited with code ${completed.exitCode}`;
    if (completed.exitCode === null || (chars && chars !== "\u0003")) {
      throw new Error(`Terminal session ${id} ${status}. Start a new command with exec_command.`);
    }
    return {
      wall_time_seconds: Math.round((performance.now() - started) / 100) / 10,
      output: "",
      exit_code: completed.exitCode,
      original_token_count: 0,
      ...(completed.terminationReason ? { termination_reason: completed.terminationReason } : {}),
      ...(completed.fullOutputPath ? { full_output_path: completed.fullOutputPath } : {}),
      ...(completed.logTruncated ? { log_truncated: true } : {}),
    };
  }

  async close(id: number): Promise<TerminalCloseStatus> {
    if (!this.sessions.has(id)) {
      const completed = this.completed.get(id);
      if (completed) return completed.exitCode === null ? "already_closed" : "root_exited";
      throw this.unknownSession(id);
    }
    const outcome = await this.request<{ termination_requested: boolean; exit_code: number | null } | null>({ op: "close", session_id: id });
    const session = this.sessions.get(id);
    if (!session) return "already_closed";
    const exitCode = outcome?.exit_code ?? session.exitCode;
    this.completed.set(id, { exitCode, terminationReason: session.terminationReason,
      ...(session.keepLog ? { fullOutputPath: session.logPath, logTruncated: session.logTruncated } : {}) });
    if (this.completed.size > MAX_SESSIONS) this.completed.delete(this.completed.keys().next().value!);
    this.sessions.delete(id);
    for (const wake of session.waiters) wake();
    if (!session.keepLog) await rm(session.logPath, { force: true });
    if (outcome) return outcome.termination_requested ? "termination_requested" : "root_exited";
    return exitCode === null ? "unconfirmed" : "root_exited";
  }

  private async finishLogs(): Promise<void> {
    for (const name of await readdir(this.outputDirectory)) {
      const path = join(this.outputDirectory, name);
      if (/^\d+\.log$/.test(name) && !this.retainedLogs.has(path)) await rm(path, { force: true });
    }
    if (this.retainedLogs.size) {
      const now = new Date();
      await utimes(this.outputDirectory, now, now);
    } else await rmdir(this.outputDirectory);
  }

  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopped = true;
    this.shutdown = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.child.kill(), 3000);
      const finish = () => {
        clearTimeout(timer);
        this.child.off("exit", finish);
        this.child.off("close", finish);
        // Process exit, not a descendant-held pipe EOF, ends the bridge.
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        this.child.stderr.destroy();
        this.finishLogs().then(() => resolve(), reject);
      };
      this.child.once("exit", finish);
      this.child.once("close", finish);
      if (this.child.pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) finish();
      else this.child.stdin.end();
    });
    return this.shutdown;
  }
}
