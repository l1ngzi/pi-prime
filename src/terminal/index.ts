import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { terminalOutputSchema } from "./output.ts";
import { execRenderers, writeRenderers } from "./render.ts";
import { MAX_WAIT_MS, resolveBinaryPath, shellPath, TerminalRuntime, type TerminalOutput } from "./runtime.ts";

const waitTime = (usage: string) => Type.Optional(Type.Integer({
  minimum: 0,
  description: `How long this call waits for output or exit. ${usage} Each wait is capped at ${MAX_WAIT_MS} ms; a running process stays available via its session_id.`,
}));
const budget = Type.Optional(Type.Integer({ minimum: 0, description: "Approximate output budget (default 8000 tokens). Use 0 for status only. Truncated output keeps the head and tail; full_output_path points to the log when available." }));
const reloadKey = Symbol.for("pi-prime.terminal.reload");
const processState = globalThis as typeof globalThis & { [reloadKey]?: WeakMap<ExtensionContext["sessionManager"], { runtime: TerminalRuntime; timer: NodeJS.Timeout }> };
const reloads = processState[reloadKey] ??= new WeakMap();
const closeNotes = {
  termination_requested: "Requested termination of the managed process tree.",
  root_exited: "The root already exited. Background descendants may still be running.",
  already_closed: "This terminal handle was already closed.",
  unconfirmed: "The handle closed. Process termination could not be confirmed by the native bridge.",
} as const;


function result(output: TerminalOutput) {
  const status = output.session_id !== undefined
    ? `${output.cancelled ? "Wait cancelled; session available" : "Running"} · session_id=${output.session_id}`
    : output.termination_reason === "ctrl_c" ? `Terminated (Ctrl+C) · exit ${output.exit_code}` : `Exit ${output.exit_code}`;
  const text = [
    `${status}${output.interrupt_sent && !output.termination_reason ? " · Ctrl+C sent" : ""}`,
    output.truncated ? `Output truncated (~${output.original_token_count} tokens).` : "",
    output.full_output_path ? `${output.log_truncated ? "Partial log" : "Full output"}: ${output.full_output_path}` : "",
    output.output,
  ].filter(Boolean).join("\n");
  return {
    content: [{ type: "text" as const, text }],
    details: output,
    structuredContent: output,
    isError: output.exit_code !== undefined && output.exit_code !== 0,
  };
}

// The runtime rejects with the abort reason only before a command launches or input reaches its
// session; later cancellation resolves with cancelled=true. Say which side of that line a call ended on.
async function explainEarlyCancel(operation: Promise<TerminalOutput>, signal: AbortSignal | undefined, message: string): Promise<TerminalOutput> {
  try {
    return await operation;
  } catch (error) {
    throw signal?.aborted && error === signal.reason ? new Error(message, { cause: error }) : error;
  }
}

export default function betterTerminal(pi: ExtensionAPI): void {
  const problems: string[] = [];
  for (const probe of [resolveBinaryPath, shellPath]) {
    try { probe(); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  }
  if (problems.length) {
    const installer = fileURLToPath(new URL("../../scripts/install-native.mjs", import.meta.url));
    const message = `[pi-prime] Native terminal skipped. ${problems.join(" ")} Pi's built-in shell tools are available. To install the helper, run node "${installer}".`;
    let warned = false;
    pi.on("session_start", (_event, ctx) => {
      if (warned) return;
      warned = true;
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(message);
    });
    return;
  }
  const windows = process.platform === "win32";
  const shell = windows ? "PowerShell" : "Bash";
  let runtime: TerminalRuntime | undefined;
  let ended = false;
  const get = async () => {
    if (ended) throw new Error("terminal session has ended");
    if (!runtime || runtime.failed) runtime = new TerminalRuntime();
    const active = runtime;
    await active.ready;
    return active;
  };
  const stop = async () => {
    ended = true;
    const active = runtime;
    runtime = undefined;
    await active?.dispose();
  };
  // Hidden exposure keeps the built-in shell tools out of both the model and codemode loadouts.
  pi.registerTool({ ...createBashToolDefinition(process.cwd()), exposure: "hidden" });
  pi.registerTool({ ...createPowerShellToolDefinition(process.cwd()), exposure: "hidden" });

  pi.registerTool({
    name: "exec_command",
    label: shell,
    description: [
      `Run ${windows ? "PowerShell 7" : "Bash"} commands with a clean shell profile.`,
      "Each exec_command starts a fresh shell; variables and cwd changes stay in that session. Use workdir for each command or write_stdin to continue an existing interactive session.",
      "Use cmd for a one-off command, yield_time_ms=0 to start a background job, or tty=true for an interactive program.",
      "A finished command succeeds when exit_code is 0; a nonzero exit_code reports failure. A session_id means it is still running; collect more output with write_stdin. Output combines stdout and stderr as received.",
    ].join("\n"),
    promptSnippet: `Run ${shell} commands and start terminal sessions`,
    parameters: Type.Object({
      cmd: Type.String({ description: (windows ? [
        "PowerShell script (multiline supported).",
        "- Exit status: exit_code is the script's final status. A native program that fails as the last command reports 1; end with `exit $LASTEXITCODE` to report its own code, which can be program-specific (rg exits 1 for no matches and 2 for an error). Earlier failures are hidden when later commands succeed, so run builds and tests in their own call as `<command>; exit $LASTEXITCODE`.",
        "- Error handling: use && between dependent commands. $ErrorActionPreference='Stop' stops on PowerShell errors; after a native program fails, the script continues unless you check $LASTEXITCODE.",
        "- For text search, use rg when installed or Select-String. Save the native exit code before running follow-up commands.",
        "- File patterns: pass them to the program, e.g. rg pattern tests -g '*.mjs'; external-command globs stay literal.",
        "- File operations: prefer native PowerShell cmdlets (e.g. Remove-Item, Move-Item with -LiteralPath) in one shell, and verify resolved target paths before recursive deletes or moves.",
        "- Readable output: format different object shapes separately; emit full paths as strings.",
      ] : [
        "Bash script (multiline supported).",
        "- Error handling: use && between dependent commands; set -e stops on unhandled failures, and set -o pipefail reports pipeline failures.",
        "- Exit status: the final command's status is returned; use exit to return a specific code.",
        "- File patterns: quote patterns for the receiving program, e.g. rg pattern tests -g '*.mjs'; unquoted globs are expanded by Bash.",
        "- File operations: quote paths and use -- before path arguments when supported.",
      ]).join("\n") }),
      workdir: Type.Optional(Type.String({ description: "Working directory; defaults to the current project directory. Relative workdir values resolve from that directory." })),
      tty: Type.Optional(Type.Boolean({ description: "Set true for an interactive program that needs keystrokes or a terminal. The default runs with stdin closed." })),
      yield_time_ms: waitTime("Default up to 10000 ms; with tty=true the default returns after a quiet output burst. Set a longer wait for long-running commands or to collect multiple output bursts. Use 0 to return promptly."),
      max_output_tokens: budget,
    }, { additionalProperties: false }),
    outputSchema: terminalOutputSchema,
    executionMode: "parallel",
    async execute(_id, params, signal, onUpdate, ctx) {
      const active = await get();
      const output = await explainEarlyCancel(active.exec({
        ...params,
        cwd: resolve(ctx.cwd, params.workdir ?? "."),
        signal,
        update: onUpdate ? output => onUpdate(result(output)) : undefined,
      }), signal, "Cancelled before launch; the command did not start.");
      return result(output);
    },
    ...execRenderers,
  });

  pi.registerTool({
    name: "write_stdin",
    label: "Terminal session",
    description: [
      "Continue a terminal session using its session_id.",
      "- Collect new output: omit chars. Later polls do not replay output you already collected.",
      "- Send input to a TTY: supply chars; append a newline to submit a line.",
      "- To send Ctrl+C, set interrupt=true and omit chars.",
      "",
      "Result: exit_code when finished, or session_id for further calls. interrupt_sent=true confirms Ctrl+C was sent.",
      "Ctrl+C terminates non-TTY process trees with termination_reason='ctrl_c'; TTY applications may handle it and continue. After exit, it collects any remaining output and the exit status.",
      ...(windows ? ["On Windows, non-TTY Ctrl+C forcibly terminates the process tree; application SIGINT handlers and finally cleanup do not run reliably. Use tty=true for interactive interrupt handling, or the application's shutdown command for graceful cleanup."] : []),
      "cancelled=true means this wait was cancelled; the session remains available. Its retained full_output_path includes output consumed before cancellation; later polls report the same log.",
    ].join("\n"),
    promptSnippet: "Collect output, send input, or interrupt a terminal session",
    parameters: Type.Object({
      session_id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Session ID returned by exec_command or a previous write_stdin call." }),
      chars: Type.Optional(Type.String({ maxLength: 131_072, description: "Input for a TTY. Append a newline to submit a line. Omit to collect output." })),
      interrupt: Type.Optional(Type.Boolean({ description: "Send Ctrl+C. Use with empty or omitted chars." })),
      yield_time_ms: waitTime("Defaults: 30000 ms collecting pipe output, 1000 ms collecting TTY output, or 250 ms after input. Default TTY waits return after a quiet burst. Set a longer wait for long-running commands or to collect multiple output bursts. Use 0 to collect what is ready now."),
      max_output_tokens: budget,
    }, { additionalProperties: false }),
    outputSchema: terminalOutputSchema,
    executionMode: "parallel",
    async execute(_id, params, signal, onUpdate) {
      const active = await get();
      const output = await explainEarlyCancel(active.write({ ...params, signal, update: onUpdate ? output => onUpdate(result(output)) : undefined }),
        signal, `Cancelled before reaching session ${params.session_id}; no input was sent.`);
      return result(output);
    },
    ...writeRenderers,
  });

  pi.registerTool({
    name: "terminal_sessions",
    label: "Terminal sessions",
    description: "List terminal sessions or close one by ID. Close requests termination of a managed live tree. If the root has exited, background descendants may continue. For interactive Ctrl+C, use write_stdin.",
    promptSnippet: "List terminal sessions or close a selected session and its process tree",
    parameters: Type.Object({
      action: Type.Optional(Type.Enum(["list", "close"], { type: "string", description: "Use list (the default) to inspect sessions, or close to stop the selected session's process tree." })),
      session_id: Type.Optional(Type.Integer({ minimum: 1, description: "Required for action=close. Use a session ID from exec_command or this tool's list." })),
    }, { additionalProperties: false }),
    outputSchema: Type.Object({
      closed_session_id: Type.Optional(Type.Integer()),
      close_status: Type.Optional(Type.Enum(Object.keys(closeNotes), { type: "string" })),
      sessions: Type.Array(Type.Object({
        session_id: Type.Integer(), command: Type.String(), cwd: Type.String(), tty: Type.Boolean(),
        status: Type.Enum(["running", "exited"], { type: "string" }), exit_code: Type.Union([Type.Integer(), Type.Null()]),
      })),
    }),
    executionMode: "parallel",
    async execute(_id, { action = "list", session_id }) {
      if (action === "close" && session_id === undefined) throw new Error("action=close requires session_id. Use action=list to find it.");
      if (action === "list" && session_id !== undefined) throw new Error("Use action=close with session_id to close a session, or action=list without an ID to list sessions.");
      const active = await get();
      const status = action === "close" ? await active.close(session_id!) : undefined;
      const details = { ...(status ? { closed_session_id: session_id, close_status: status } : {}), sessions: active.list() };
      return { content: [{ type: "text", text: [status ? closeNotes[status] : "", JSON.stringify(details)].filter(Boolean).join("\n") }], details, structuredContent: details };
    },
  });

  pi.on("session_start", async (event, ctx) => {
    await stop();
    ended = false;
    const saved = event.reason === "reload" ? reloads.get(ctx.sessionManager) : undefined;
    if (saved) {
      reloads.delete(ctx.sessionManager);
      clearTimeout(saved.timer);
      runtime = saved.runtime;
    }
  });
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "reload" || !runtime) return stop();
    const active = runtime;
    runtime = undefined;
    ended = true;
    // The new extension instance takes ownership. If it was removed or failed
    // to load, the previous instance still cleans up its process tree.
    const manager = ctx.sessionManager;
    const timer = setTimeout(() => {
      reloads.delete(manager);
      void active.dispose().catch(error => console.warn("[pi-prime] Terminal shutdown failed:", error));
    }, 30_000).unref();
    reloads.set(manager, { runtime: active, timer });
  });

  pi.registerCommand("terminal", {
    description: "List terminal sessions, or /terminal close <session_id|all> to terminate live process trees.",
    async handler(args, ctx) {
      const active = await get();
      const [command, target, extra] = args.trim().split(/\s+/);
      if (!command) {
        const lines = active.list().map(session => `${session.session_id} ${session.status === "running" ? "running" : `exited ${session.exit_code}`} ${session.tty ? "TTY" : "pipe"} ${session.command}`);
        ctx.ui.notify(lines.join("\n") || "No terminal sessions.", "info");
      } else if (command === "close" && target && !extra) {
        const ids = target === "all" ? [...active.sessions.keys()] : /^\d+$/.test(target) ? [Number(target)] : [];
        if (!ids.length && target !== "all") throw new Error("Usage: /terminal close <session_id|all>");
        const results = await Promise.all(ids.map(async id => `${id} · ${closeNotes[await active.close(id)]}`));
        ctx.ui.notify(results.join("\n") || "No terminal sessions.", "info");
      } else throw new Error("Usage: /terminal [close <session_id|all>]");
    },
  });
}
