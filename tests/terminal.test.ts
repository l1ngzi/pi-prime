import assert from "node:assert/strict";
import crypto, { generateKeyPairSync, randomUUID } from "node:crypto";
import childProcess, { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { after, test } from "node:test";
import ssh2 from "ssh2";
import { Type } from "typebox";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, initTheme, SessionManager, SettingsManager, ToolExecutionComponent,
  type AgentToolResult, type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { artifactsRoot } from "../src/artifacts.ts";
import { OutputBuffer } from "../src/terminal/output.ts";
import { resolveBinaryPath, TerminalRuntime, type TerminalOutput } from "../src/terminal/runtime.ts";
import betterTerminal from "../src/terminal/index.ts";

const { Server } = ssh2;
const cwd = realpathSync.native(await mkdtemp(join(tmpdir(), "pi-prime-terminal-中文 O'Brien-")));
after(() => rm(cwd, { recursive: true, force: true }));
const windows = process.platform === "win32";
const shell = (powershell: string, bash: string) => windows ? powershell : bash;
const quote = (text: string) => `'${text.replaceAll("'", windows ? "''" : "'\"'\"'")}'`;
const node = (script: string) => `${windows ? "& " : ""}${quote(process.execPath)} -e ${quote(script)}`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    // Linux can retain an exited descendant as a zombie until its parent reaps it.
    return process.platform !== "linux" || !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch { return false; }
};
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function start(runtime: TerminalRuntime, cmd: string, tty: boolean, marker = "READY"): Promise<TerminalOutput & { session_id: number }> {
  const controller = new AbortController();
  const output = await runtime.exec({ cmd, cwd, tty, yield_time_ms: 5000, signal: controller.signal, update: output => {
    if (output.output.includes(marker)) controller.abort();
  } });
  assert.equal(output.cancelled, true, JSON.stringify(output));
  assert.equal(output.termination_reason, undefined);
  assert.equal(output.interrupt_sent, undefined);
  assert.ok(output.session_id);
  return output as TerminalOutput & { session_id: number };
}

test("a failed bridge rejects its current call and the next call starts a fresh bridge", async t => {
  const tools = new Map<string, ToolDefinition>();
  let shutdown!: Function;
  betterTerminal({ registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {},
    on(name: string, handler: Function) { if (name === "session_shutdown") shutdown = handler; },
  } as unknown as ExtensionAPI);
  t.after(() => shutdown({ reason: "quit" }, {}));
  const spawns = t.mock.method(childProcess, "spawn");
  syncBuiltinESMExports();
  t.after(() => { spawns.mock.restore(); syncBuiltinESMExports(); });
  const schedule = globalThis.setTimeout;
  let expire!: () => void;
  const timer = t.mock.method(globalThis, "setTimeout", (fn: () => void, ms?: number) => {
    if (ms === 10_000) expire = fn;
    return schedule(fn, ms);
  });
  const list = () => tools.get("terminal_sessions")!.execute("list", {}, undefined, undefined, { cwd } as never);
  const startup = list();
  expire();
  await assert.rejects(startup, /startup timed out/);
  timer.mock.restore();
  await list();
  const bridge = spawns.mock.calls.at(-1)!.result!;
  const gone = new Promise<void>(resolve => bridge.once("close", () => resolve()));
  const command = tools.get("exec_command")!.execute("crash", { cmd: "exit 0" }, undefined, () => bridge.kill(), { cwd } as never);
  await assert.rejects(command, /native process exited|EPIPE|stream|pipe/i);
  await gone;
  assert.deepEqual((await list()).structuredContent, { sessions: [] });
  assert.equal(spawns.mock.callCount(), 3);
});

for (const missing of ["helper", "shell", "helper and shell"]) {
  test(`missing ${missing} preserves the built-in shell tools and warns once`, async t => {
    const { PI_PRIME_TERMINAL_BIN: binary, PATH: searchPath } = process.env;
    t.after(() => {
      if (binary === undefined) delete process.env.PI_PRIME_TERMINAL_BIN;
      else process.env.PI_PRIME_TERMINAL_BIN = binary;
      if (searchPath === undefined) delete process.env.PATH;
      else process.env.PATH = searchPath;
    });
    process.env.PI_PRIME_TERMINAL_BIN = missing.includes("helper") ? join(cwd, "absent") : process.execPath;
    if (missing.includes("shell")) process.env.PATH = "";
    let start!: Function;
    betterTerminal({
      registerTool: assert.fail, registerCommand: assert.fail,
      on(name: string, handler: Function) { assert.equal(name, "session_start"); start = handler; },
    } as unknown as ExtensionAPI);
    const warnings: string[] = [];
    const ctx = { hasUI: true, ui: { notify(message: string, level: string) { assert.equal(level, "warning"); warnings.push(message); } } };
    await start({}, ctx);
    await start({}, ctx);
    assert.equal(warnings.length, 1);
    if (missing.includes("helper")) assert.match(warnings[0], /PI_PRIME_TERMINAL_BIN/);
    if (missing.includes("shell")) assert.match(warnings[0], windows ? /PowerShell 7/ : /bash on PATH/);
    assert.ok(warnings[0].includes(fileURLToPath(new URL("../scripts/install-native.mjs", import.meta.url))));
  });
}

test("zero-yield exit waits for a second poll to drain the final bytes", async t => {
  const runtime = new TerminalRuntime();
  t.after(() => runtime.dispose());
  await runtime.ready;
  const bytes = Buffer.from("终");
  const calls: string[] = [];
  let polls = 0;
  Object.assign(runtime, { async request({ op }: { op: string }) {
    calls.push(op);
    if (op === "spawn") return;
    if (op === "close") return { termination_requested: false, exit_code: 0 };
    assert.equal(op, "poll");
    const closed = ++polls === 2;
    const chunk = closed ? bytes.subarray(1) : bytes.subarray(0, 1);
    return { head: chunk.toString("base64"), tail: "", original_bytes: chunk.length, omitted_bytes: 0,
      exit_code: 0, output_closed: closed, log_available: false, failure: null };
  } });
  const first = await runtime.exec({ cmd: "exit 0", cwd, yield_time_ms: 0 });
  assert.ok(first.session_id);
  assert.equal(first.exit_code, undefined);
  assert.equal(first.output, "");
  assert.deepEqual(calls, ["spawn", "poll"]);
  const last = await runtime.write({ session_id: first.session_id, yield_time_ms: 0 });
  assert.equal(last.output, "终");
  assert.equal(last.exit_code, 0);
  assert.equal(last.session_id, undefined);
  assert.deepEqual(calls, ["spawn", "poll", "poll", "close"]);
});

test("head/tail budgets keep UTF-8 and line boundaries and support zero output", () => {
  const output = new OutputBuffer(101);
  output.append(Buffer.from("HEAD 中文😀" + "数据😀".repeat(100) + " 中文😀TAIL"));
  assert.equal(output.retainedBytes, 101);
  assert.equal(output.truncated, true);
  assert.match(output.text, /^HEAD.*output truncated.*TAIL$/s);
  assert.ok(!output.text.includes("�"));
  const silent = new OutputBuffer(0);
  silent.append(Buffer.from("discard"));
  assert.equal(silent.text, "");
  assert.equal(silent.retainedBytes, 0);
  const titled = new OutputBuffer(1000);
  titled.append(Buffer.from("\x1b]0;TITLE\x07VISIBLE\x1b]0;TITLE\x1b\\TEXT"));
  assert.equal(titled.text, "VISIBLETEXT");
  const spacing = new OutputBuffer(1000);
  spacing.append(Buffer.from("\x1b[2J\x1b[m\x1b[2;1H\r\n  indented\r\n\x1b[2;1Hnext\x1b[H"));
  assert.equal(spacing.text, "\n\n  indented\nnext");
  const lines = new OutputBuffer(160);
  lines.append(Buffer.from(Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(3, "0")} 中文\n`).join("")));
  assert.match(lines.text, /^line-000 中文\n/);
  assert.match(lines.text, /line-019 中文\n$/);
  for (const line of lines.text.trimEnd().split("\n")) assert.match(line, /^(line-\d{3} 中文|\.\.\. output truncated \.\.\.)$/);
});

test("cancellation retains consumed EARLY output through exit and repeated polls", async () => {
  const runtime = new TerminalRuntime();
  try {
    const early = await start(runtime, node('console.log("EARLY");setTimeout(()=>console.log("LATE"),600)'), false, "EARLY");
    assert.ok(early.full_output_path);
    assert.match(await readFile(early.full_output_path, "utf8"), /EARLY/);
    const done = await runtime.write({ session_id: early.session_id, yield_time_ms: 2000 });
    assert.equal(done.exit_code, 0);
    assert.equal(done.full_output_path, early.full_output_path);
    assert.match(await readFile(done.full_output_path!, "utf8"), /EARLY[\s\S]*LATE/);
    assert.equal((await runtime.write({ session_id: early.session_id })).full_output_path, early.full_output_path);
    await assert.rejects(runtime.write({ session_id: early.session_id, chars: "text", interrupt: true }), /without chars/);
  } finally { await runtime.dispose(); }
});

test("line redraws keep the latest update and preserve real newlines", () => {
  const output = new OutputBuffer(1000);
  output.append(Buffer.from("before\r\n\x1b[32mprogress 10%\x1b[0m\r"));
  assert.equal(output.text, "before\nprogress 10%");
  output.append(Buffer.from("\x1b[32mprogress 100%\x1b[0m\r"));
  assert.equal(output.text, "before\nprogress 100%");
  output.append(Buffer.from("done\r"));
  assert.equal(output.text, "before\ndone");
  output.append(Buffer.from("\n\n  after\r\n"));
  assert.equal(output.text, "before\ndone\n\n  after\n");
  const positioned = new OutputBuffer(1000);
  positioned.append(Buffer.from("\x1b[Hbefore\r\nprogress 10%\x1b[2;1Hprogress 100%\x1b[3;1Hnext\x1b[1Gdone\x1b[H"));
  assert.equal(positioned.text, "before\nprogress 100%\ndone");
});

test("PowerShell 7, Unicode/quoted cwd, stderr and exit codes", { skip: !windows }, async () => {
  const runtime = new TerminalRuntime();
  try {
    const output = await runtime.exec({ cwd, cmd: "$PSVersionTable.PSVersion.Major; $PWD.ProviderPath; '中文 😀'; [Console]::Error.WriteLine('STDERR'); exit 7" });
    assert.equal(output.exit_code, 7);
    assert.equal(output.session_id, undefined);
    assert.match(output.output, /7\n/);
    assert.ok(output.output.includes(cwd), output.output);
    assert.ok(output.output.includes("中文 😀"));
    assert.ok(output.output.includes("STDERR"));
    const failed = await runtime.exec({ cwd, cmd: "'first'\n'second'\nthrow 'source marker'" });
    assert.match(failed.output, /\n\s*3 \|\s*throw 'source marker'/);
    assert.doesNotMatch(failed.output, /\n\s*4 \|/);
  } finally { await runtime.dispose(); }
});

test("PowerShell source positions and UTF-8 defaults survive pipe and TTY execution", { skip: !windows }, async t => {
  const runtime = new TerminalRuntime();
  t.after(() => runtime.dispose());
  for (const tty of [false, true]) {
    const encoding = await runtime.exec({ cwd, tty, cmd: '[Console]::OutputEncoding.CodePage; $OutputEncoding.CodePage; $PSStyle.OutputRendering; "中文 😀"; [Console]::Error.WriteLine("错误 😀")' });
    assert.match(encoding.output, /65001\n65001\nPlainText/);
    assert.match(encoding.output, /中文 😀/);
    assert.match(encoding.output, /错误 😀/);
    // Fix this fixture's diagnostic language without adding a line to its source.
    const result = await runtime.exec({ cwd, tty, cmd: "[Threading.Thread]::CurrentThread.CurrentUICulture='en-US'; function f {\nthrow 'marker'\n}\ntry { f } catch { \"ROW=$($_.InvocationInfo.ScriptLineNumber)\"; $_.ScriptStackTrace }\n$ErrorView='NormalView'; throw 'normal marker'" });
    assert.equal(result.exit_code, 1);
    assert.match(result.output, /ROW=2/);
    assert.match(result.output, /at f, <No file>: line 2/);
    assert.match(result.output, /at <ScriptBlock>, <No file>: line 4/);
    assert.match(result.output, /At line:5 char:/);
  }
  // Streaming updates on an ordinary short command must not pin full_output_path or leak its log directory.
  const updates: TerminalOutput[] = [];
  const short = await runtime.exec({
    cwd,
    cmd: "'STREAM_CHUNK_ONE'; Start-Sleep -Milliseconds 150; 'STREAM_CHUNK_TWO'",
    update: output => updates.push(output),
  });
  assert.ok(updates.length >= 1);
  assert.equal(short.exit_code, 0);
  assert.equal(short.full_output_path, undefined);
});

test("a later failed poll preserves earlier output in the log without replaying it", { skip: !windows }, async t => {
  const runtime = new TerminalRuntime();
  t.after(() => runtime.dispose());
  const marker = "EARLIER_OUTPUT";
  const first = await start(runtime, `'${marker}'; Start-Sleep -Milliseconds 400; exit 1`, false, marker);
  const done = await runtime.write({ session_id: first.session_id });
  assert.equal(done.exit_code, 1);
  assert.equal(done.output.trim(), "");
  assert.match(await readFile(done.full_output_path!, "utf8"), /EARLIER_OUTPUT/);
  const hidden = await runtime.exec({ cwd, cmd: "'visible in the log'; exit 1", max_output_tokens: 0 });
  assert.equal(hidden.exit_code, 1);
  assert.equal(hidden.output, "");
  assert.match(await readFile(hidden.full_output_path!, "utf8"), /visible in the log/);
});

test("Windows pipe and TTY sessions stay UTF-8 even when the parent host console uses CP936", { skip: !windows }, async () => {
  const probeJs = `
    import { existsSync } from "node:fs";
    import { TerminalRuntime } from ${JSON.stringify(new URL("../src/terminal/runtime.ts", import.meta.url).href)};
    const rt = new TerminalRuntime();
    const dir = rt["outputDirectory"];
    const out = [];
    try {
      for (const tty of [false, true]) {
        const res = await rt.exec({ cwd: ${JSON.stringify(cwd)}, tty, yield_time_ms: 10_000, cmd: '[Console]::OutputEncoding.CodePage; "中文 😀"', update: () => {} });
        out.push({ tty, text: res.output.trim(), log: res.full_output_path, exit: res.exit_code });
      }
    } finally {
      await rt.dispose();
    }
    console.log(JSON.stringify({ out, dirRemoved: !existsSync(dir) }));
  `;
  const b64 = Buffer.from(probeJs, "utf8").toString("base64");
  const ps = `
    Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class WinCon { [DllImport("kernel32.dll")] public static extern bool AllocConsole(); [DllImport("kernel32.dll")] public static extern bool SetConsoleCP(uint cp); [DllImport("kernel32.dll")] public static extern bool SetConsoleOutputCP(uint cp); }'
    [WinCon]::AllocConsole() | Out-Null
    [WinCon]::SetConsoleCP(936) | Out-Null
    [WinCon]::SetConsoleOutputCP(936) | Out-Null
    & ${quote(process.execPath)} --import tsx -e "import('data:text/javascript;base64,${b64}')"
  `;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const child = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    cwd: dirname(fileURLToPath(import.meta.url)), windowsHide: true, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const parsed = JSON.parse(child.stdout.trim()) as { out: { tty: boolean; text: string; log?: string; exit?: number }[]; dirRemoved: boolean };
  assert.equal(parsed.dirRemoved, true, "unretained terminal artifact directory must be removed on dispose");
  for (const item of parsed.out) {
    assert.equal(item.exit, 0);
    assert.equal(item.log, undefined);
    assert.match(item.text, /^65001\n中文 😀$/);
  }
  // Even when a console starts at OEMCP 936 or 437 (standard Chinese/English Windows), the native
  // UTF-8 shim switches both pipe and ConPTY consoles to 65001 so UTF-8 streams never mojibake.
  const runtime = new TerminalRuntime();
  try {
    const exe = resolveBinaryPath();
    for (const tty of [false, true]) {
      const recovered = await runtime.exec({
        cwd,
        tty,
        yield_time_ms: 10_000,
        cmd: `chcp.com 437 > $null; & ${quote(exe)} --conpty-utf8-exec pwsh.exe -NoLogo -NoProfile -Command '[Console]::InputEncoding.CodePage; [Console]::OutputEncoding.CodePage; "中文 😀"; node -e "fs.writeSync(1, Buffer.from(String.fromCodePoint(0x4e2d,0x6587,0x20,0x1f600,10)))"'`,
      });
      assert.equal(recovered.exit_code, 0);
      assert.match(recovered.output, /65001\n65001\n中文 😀\n中文 😀/);
    }
  } finally {
    await runtime.dispose();
  }
});

test("TTY trims excess trailing blank rows while pipe output preserves them", async t => {
  const runtime = new TerminalRuntime();
  t.after(() => runtime.dispose());
  for (const tty of [false, true]) {
    const result = await runtime.exec({ cwd, cmd: node('process.stdout.write("ROW\\n\\n\\n\\n")'), tty });
    assert.equal(result.exit_code, 0);
    if (tty) assert.match(result.output, /ROW\n?$/);
    else assert.equal(result.output, "ROW\n\n\n\n");
  }
});

test("Windows Python TTY accepts non-BMP input with the terminal's default basic REPL", { skip: !windows || spawnSync("python", ["--version"]).status !== 0 }, async t => {
  const runtime = new TerminalRuntime();
  t.after(() => runtime.dispose());
  const begin = await runtime.exec({ cwd, cmd: "python -q", tty: true });
  assert.ok(begin.session_id);
  const result = await runtime.write({ session_id: begin.session_id, chars: 's="a😀b𠀀c"; print("COUNT",len(s),[hex(ord(c)) for c in s])\n' });
  assert.match(result.output, /COUNT 5/);
  assert.match(result.output, /0x1f600.*0x20000/);
  await runtime.close(begin.session_id);
});

test("PowerShell failures report the shell's output and exit status without re-execution", { skip: !windows }, async () => {
  const runtime = new TerminalRuntime();
  try {
    const invalidScriptMarker = join(cwd, "invalid-script-ran.txt");
    for (const tty of [false, true]) {
      for (const cmd of [`[IO.File]::WriteAllText(${quote(invalidScriptMarker)}, 'ran');\nif (`, "Write-Output '未闭合"]) {
        // Some pwsh versions return only exit 1 for incomplete input. Forward whatever this shell emits.
        const native = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cmd],
          { encoding: "utf8", windowsHide: true, env: { ...process.env, NO_COLOR: "1", TERM: "dumb" } });
        assert.equal(native.status, 1);
        const output = await runtime.exec({ cwd, cmd, tty, yield_time_ms: 10_000 });
        assert.equal(output.exit_code, native.status);
        if (!(native.stderr + native.stdout).trim()) assert.equal(output.output.trim(), "");
        assert.equal(existsSync(invalidScriptMarker), false);
      }
      const cmd = "1 + * 2";
      const error = await runtime.exec({ cwd, cmd, tty, max_output_tokens: 1, yield_time_ms: 10_000 });
      assert.equal(error.exit_code, 1);
      assert.ok(error.truncated && error.full_output_path);
      const log = stripVTControlCharacters(await readFile(error.full_output_path, "utf8"));
      assert.match(log, /ParserError/);
      assert.ok(log.includes(cmd));
    }
    const marker = join(cwd, "silent-failure.txt");
    const silent = await runtime.exec({ cwd, cmd: `[IO.File]::AppendAllText(${quote(marker)}, 'once'); exit 1` });
    assert.equal(silent.exit_code, 1);
    assert.equal(silent.output, "");
    assert.equal(await readFile(marker, "utf8"), "once");
    for (const [cmd, exitCode] of [
      ["Write-Error 'expected error'; 'continued'", 0],
      ["Write-Error 'expected error'; return", 1],
      ["$ErrorActionPreference='Stop'; Write-Error 'expected error'; 'MUST_NOT_RUN'", 1],
      ["cmd.exe /c exit 7", 1],
      ["cmd.exe /c exit 7; exit $LASTEXITCODE", 7],
      ["cmd.exe /c exit 7; 'continued'", 0],
      ["cmd.exe /c exit 7; Write-Error 'later PowerShell failure'", 1],
    ] as const) {
      const output = await runtime.exec({ cwd, cmd });
      assert.equal(output.exit_code, exitCode, cmd);
      assert.ok(!output.output.includes("MUST_NOT_RUN"), output.output);
    }
  } finally { await runtime.dispose(); }
});

test("Bash handles shell syntax, Unicode/quoted cwd, stderr and exit codes", { skip: windows }, async () => {
  const runtime = new TerminalRuntime();
  try {
    for (const tty of [false, true]) {
      const output = await runtime.exec({ cwd, tty, cmd: "[[ -n $BASH_VERSION ]] || exit 99; printf '%s\\n' \"$PWD\" '中文 😀'; printf 'STDERR\\n' >&2; exit 7" });
      assert.equal(output.exit_code, 7);
      assert.equal(output.session_id, undefined);
      assert.ok(output.output.includes(cwd), output.output);
      assert.ok(output.output.includes("中文 😀"));
      assert.ok(output.output.includes("STDERR"));
      const invalid = await runtime.exec({ cwd, tty, cmd: "if (" });
      assert.equal(invalid.exit_code, 2);
      assert.match(invalid.output, /syntax error/);
    }
    const marker = join(cwd, "bash-silent-failure.txt");
    const silent = await runtime.exec({ cwd, cmd: `printf once >> ${quote(marker)}; exit 1` });
    assert.equal(silent.exit_code, 1);
    assert.equal(silent.output, "");
    assert.equal(await readFile(marker, "utf8"), "once");
    for (const [cmd, exitCode, expected] of [
      ["false; printf continued", 0, "continued"],
      ["false && printf MUST_NOT_RUN", 1, ""],
      ["set -e; false; printf MUST_NOT_RUN", 1, ""],
      ["set -o pipefail; false | true", 1, ""],
      ["read -r value; printf 'STDIN=%s' \"$?\"", 0, "STDIN=1"],
    ] as const) {
      const output = await runtime.exec({ cwd, cmd });
      assert.equal(output.exit_code, exitCode, cmd);
      assert.equal(output.output, expected, cmd);
    }
  } finally { await runtime.dispose(); }
});

test("WSL ps gets a valid height while long command lines remain intact", { skip: !windows }, async t => {
  if (spawnSync("wsl.exe", ["--exec", "true"], { windowsHide: true, timeout: 5000 }).status !== 0) {
    t.skip("WSL distro unavailable");
    return;
  }
  const runtime = new TerminalRuntime();
  try {
    const output = await runtime.exec({ cwd, cmd: `wsl.exe --exec sh -c 'printf "ROWS=%s\\n" "$LINES"; ps -p $$ -o args=; :' ('x' * 200 + 'WSL_WIDTH_END')` });
    assert.equal(output.exit_code, 0, output.output);
    assert.match(output.output, /ROWS=30/);
    assert.doesNotMatch(output.output, /screen size is bogus/);
    assert.ok(output.output.includes("x".repeat(200) + "WSL_WIDTH_END"), output.output);
  } finally { await runtime.dispose(); }
});

test("six-digit session IDs retry collisions with both live and closed sessions", async t => {
  const candidates = [100_000, 100_000, 999_999, 100_000, 999_999, 482_731];
  const random = t.mock.method(crypto, "randomInt", (min: number, max: number) => {
    assert.equal(min, 100_000);
    assert.equal(max, 1_000_000);
    const id = candidates.shift();
    assert.ok(id, "unexpected ID allocation");
    return id;
  });
  syncBuiltinESMExports();
  t.after(() => { random.mock.restore(); syncBuiltinESMExports(); });
  const runtime = new TerminalRuntime();
  try {
    const options = { cwd, cmd: shell("Start-Sleep -Seconds 30", "sleep 30"), yield_time_ms: 0 };
    const first = await runtime.exec(options);
    const second = await runtime.exec(options);
    assert.equal(first.session_id, 100_000);
    assert.equal(second.session_id, 999_999);
    await runtime.close(first.session_id!);
    const third = await runtime.exec(options);
    assert.equal(third.session_id, 482_731);
    assert.equal(candidates.length, 0);
    await assert.rejects(runtime.write({ session_id: first.session_id! }), /was closed/);
    for (const session_id of [second.session_id!, third.session_id!]) {
      assert.equal((await runtime.write({ session_id, yield_time_ms: 0 })).session_id, session_id);
    }
  } finally { await runtime.dispose(); }
});

test("default pipe waits finish short commands without an extra polling round", async () => {
  const runtime = new TerminalRuntime();
  try {
    const command = shell("Start-Sleep -Milliseconds 1300; 'DONE'", "sleep 1.3; printf 'DONE\\n'");
    const direct = await runtime.exec({ cwd, cmd: command });
    assert.equal(direct.exit_code, 0);
    assert.equal(direct.output.trim(), "DONE");
    const background = await runtime.exec({ cwd, cmd: command, yield_time_ms: 0 });
    assert.ok(background.session_id);
    const polled = await runtime.write({ session_id: background.session_id });
    assert.equal(polled.exit_code, 0);
    assert.equal(polled.output.trim(), "DONE");
  } finally { await runtime.dispose(); }
});

test("long wait windows accept up to 300s, and default collection spans jobs past the 10s exec default", async () => {
  const runtime = new TerminalRuntime();
  try {
    const [direct, background] = await Promise.all([
      runtime.exec({ cwd, cmd: node('setTimeout(() => console.log("LONG_DONE"), 1500)'), yield_time_ms: 60_000 }),
      runtime.exec({ cwd, cmd: node('setTimeout(() => console.log("COLLECT_DONE"), 11000)'), yield_time_ms: 0 }),
    ]);
    assert.equal(direct.exit_code, 0, JSON.stringify(direct));
    assert.match(direct.output, /LONG_DONE/);
    assert.ok(background.session_id);
    const finished = await runtime.write({ session_id: background.session_id });
    assert.equal(finished.exit_code, 0, JSON.stringify(finished));
    assert.match(finished.output, /COLLECT_DONE/);
  } finally { await runtime.dispose(); }
});

test("session discovery recovers unknown IDs and closing one session preserves another", async () => {
  const runtime = new TerminalRuntime();
  try {
    const cmd = node('console.log("READY"); setInterval(() => {}, 1000)');
    const first = await start(runtime, cmd, false);
    const second = await start(runtime, cmd, false);
    const sessions = runtime.list();
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every(s => s.cwd === cwd && !s.tty && s.status === "running" && s.command.includes("READY")));
    await assert.rejects(runtime.write({ session_id: 42 }), error => {
      const message = String(error);
      return message.includes(String(first.session_id)) && message.includes(String(second.session_id)) && message.includes("terminal_sessions");
    });
    await runtime.close(first.session_id);
    await runtime.close(first.session_id); // Repeated cleanup is harmless.
    assert.deepEqual(runtime.list().map(s => s.session_id), [second.session_id]);
    assert.equal((await runtime.write({ session_id: second.session_id, yield_time_ms: 0 })).session_id, second.session_id);
    await assert.rejects(runtime.close(42), /Unknown terminal session 42/);
  } finally { await runtime.dispose(); }
});

test("TTY survives cancelled wait; native line endings and Unicode input are incremental", async () => {
  const runtime = new TerminalRuntime();
  try {
    const initial = await start(runtime, shell("[Console]::Write('progress 0%'); Start-Sleep -Milliseconds 150; [Console]::Write(\"`rprogress 50%\"); Start-Sleep -Milliseconds 150; [Console]::WriteLine(\"`rprogress 100%\"); [Console]::WriteLine('READY'); for($i=0;$i -lt 2;$i++){ $line=[Console]::ReadLine(); [Console]::WriteLine(\"OUT[$i]=$line\") }", "printf 'progress 0%%'; sleep .15; printf '\\rprogress 50%%'; sleep .15; printf '\\rprogress 100%%\\nREADY\\n'; for i in 0 1; do IFS= read -r line; printf 'OUT[%s]=%s\\n' \"$i\" \"$line\"; done"), true);
    assert.match(initial.output, /^progress 100%\nREADY/, initial.output);
    const first = await runtime.write({ session_id: initial.session_id, chars: windows ? "first\r" : "first\n" });
    assert.ok(first.output.includes("OUT[0]=first"));
    assert.ok(!first.output.includes("READY"));
    const second = await runtime.write({ session_id: initial.session_id, chars: windows ? "\n中文😀\n" : "中文😀\n", yield_time_ms: 2000 });
    assert.ok(second.output.includes("OUT[1]=中文😀"));
    assert.ok(!second.output.includes("OUT[0]"));
    assert.equal(second.exit_code, 0);
    const finished = await runtime.write({ session_id: initial.session_id });
    assert.equal(finished.exit_code, 0);
    assert.equal(finished.output, "");
    await assert.rejects(runtime.write({ session_id: initial.session_id, chars: "more\n" }), /exited with code 0/);
    const spacing = await runtime.exec({ cwd, tty: true, cmd: shell('[Console]::Write("`n`n  indented`n")', "printf '\\n\\n  indented\\n'") });
    assert.equal(spacing.output, "\n\n  indented\n");
  } finally { await runtime.dispose(); }
});

test("cancelled queued writer cannot unlock an active collector", async () => {
  const runtime = new TerminalRuntime();
  try {
    const initial = await start(runtime, shell("[Console]::WriteLine('READY'); for($i=0;$i -lt 2;$i++){ $line=[Console]::ReadLine(); if($line -eq 'A'){ Start-Sleep -Milliseconds 800 }; [Console]::WriteLine(\"OUT=$line\") }", "printf 'READY\\n'; for i in 0 1; do IFS= read -r line; if [[ $line == A ]]; then sleep .8; fi; printf 'OUT=%s\\n' \"$line\"; done"), true);
    const first = runtime.write({ session_id: initial.session_id, chars: "A\n", yield_time_ms: 1500 });
    const controller = new AbortController();
    const queued = runtime.write({ session_id: initial.session_id, chars: "X\n", signal: controller.signal });
    const rejected = assert.rejects(queued, /abort/i);
    controller.abort();
    const third = runtime.write({ session_id: initial.session_id, chars: "B\n", yield_time_ms: 2000 });
    const [a, b] = await Promise.all([first, third, rejected]).then(values => [values[0], values[1]]);
    assert.ok(a.output.includes("OUT=A"));
    assert.ok(!a.output.includes("OUT=B"));
    assert.ok(b.output.includes("OUT=B"));
    assert.ok(!b.output.includes("OUT=A"));
    assert.equal(b.exit_code, 0);
  } finally { await runtime.dispose(); }
});

test("default TTY settles promptly; explicit zero drains or starts without waiting", async t => {
  const runtime = new TerminalRuntime();
  try {
    let readyAt = 0;
    const began = performance.now();
    const initial = await runtime.exec({ cwd, tty: true,
      cmd: shell("[Console]::WriteLine('READY'); $line=[Console]::ReadLine(); [Console]::WriteLine(\"OUT=$line\"); [Console]::ReadLine() > $null", "printf 'READY\\n'; IFS= read -r line; printf 'OUT=%s\\n' \"$line\"; read -r"),
      update: output => { if (!readyAt && output.output.includes("READY")) readyAt = performance.now(); },
    });
    const startup = performance.now() - began;
    assert.ok(initial.session_id);
    assert.ok(readyAt);
    assert.ok(performance.now() - readyAt < 500, "a visible prompt must not wait for the default deadline");
    const polling = performance.now();
    const empty = await runtime.write({ session_id: initial.session_id, yield_time_ms: 0 });
    assert.equal(empty.output, "");
    assert.ok(performance.now() - polling < 500, "explicit zero polling must not acquire a hidden wait floor");
    const typing = performance.now();
    const echo = await runtime.write({ session_id: initial.session_id, chars: "first\n" });
    const input = performance.now() - typing;
    assert.ok(echo.output.includes("OUT=first"));
    assert.ok(!echo.output.includes("READY"));
    assert.equal((await runtime.write({ session_id: initial.session_id, chars: "quit\n" })).exit_code, 0);
    const burst = await runtime.exec({ cwd, tty: true,
      cmd: shell("[Console]::WriteLine('WAVE_ONE'); Start-Sleep -Milliseconds 350; [Console]::WriteLine('WAVE_TWO'); $null=[Console]::ReadLine()", "printf 'WAVE_ONE\\n'; sleep .35; printf 'WAVE_TWO\\n'; read -r"),
    });
    assert.ok(burst.session_id);
    const late = await runtime.write({ session_id: burst.session_id, yield_time_ms: 500 });
    assert.ok((burst.output + late.output).includes("WAVE_TWO"), "early quiet return must preserve later output");
    assert.ok(!late.output.includes("WAVE_ONE"));
    assert.equal((await runtime.write({ session_id: burst.session_id, chars: "quit\n" })).exit_code, 0);
    const spawning = performance.now();
    const pending = await runtime.exec({ cwd, cmd: shell("Start-Sleep -Seconds 20", "sleep 20"), yield_time_ms: 0 });
    assert.ok(pending.session_id);
    assert.ok(performance.now() - spawning < 500, "explicit zero exec must not wait for command completion");
    await runtime.close(pending.session_id);
    t.diagnostic(`TTY prompt ${startup.toFixed(0)} ms; input response ${input.toFixed(0)} ms`);
  } finally { await runtime.dispose(); }
});

test("input yields pure polls; Ctrl+C also preempts responses; cancelled tickets do not stick", async t => {
  const runtime = new TerminalRuntime();
  try {
    const terminal = await start(runtime, shell("[Console]::WriteLine('READY'); $line=[Console]::ReadLine(); [Console]::WriteLine(\"OUT=$line\")", "printf 'READY\\n'; IFS= read -r line; printf 'OUT=%s\\n' \"$line\""), true);
    const poll = runtime.write({ session_id: terminal.session_id, yield_time_ms: 5000 });
    await delay(50);
    const typing = performance.now();
    const [waiting, response] = await Promise.all([poll, runtime.write({ session_id: terminal.session_id, chars: "first\n", yield_time_ms: 1000 })]);
    const inputLatency = performance.now() - typing;
    assert.ok(inputLatency < 1500, "input must not wait behind an older 5-second poll");
    assert.equal(waiting.session_id, terminal.session_id);
    assert.ok(response.output.includes("OUT=first"));
    assert.equal(response.exit_code, 0);
    const initial = await start(runtime, node("console.log('READY');setTimeout(()=>{},20000)"), false);
    const first = runtime.write({ session_id: initial.session_id, yield_time_ms: 5000 });
    const second = runtime.write({ session_id: initial.session_id, yield_time_ms: 5000 });
    await delay(50);
    const controller = new AbortController();
    const cancelled = runtime.write({ session_id: initial.session_id, chars: "\u0003", signal: controller.signal });
    const rejected = assert.rejects(cancelled, /abort/i);
    controller.abort();
    await rejected;
    assert.equal(runtime.sessions.get(initial.session_id)?.pendingInputs, 0);
    assert.equal(runtime.sessions.get(initial.session_id)?.pendingInterrupts, 0);
    const interrupting = performance.now();
    const [a, b, killed] = await Promise.all([first, second, runtime.write({ session_id: initial.session_id, interrupt: true, yield_time_ms: 1000 })]);
    const interruptLatency = performance.now() - interrupting;
    assert.ok(interruptLatency < 1500, "Ctrl+C must not wait behind either 5-second poll");
    assert.equal(a.session_id, initial.session_id);
    assert.equal(b.session_id, initial.session_id);
    assert.ok(killed.exit_code !== undefined && killed.exit_code !== 0);
    assert.equal(killed.termination_reason, "ctrl_c");
    assert.equal(killed.interrupt_sent, true);
    assert.equal(killed.cancelled, undefined);
    const finished = await runtime.write({ session_id: initial.session_id });
    assert.equal(finished.termination_reason, "ctrl_c");
    assert.equal(finished.exit_code, killed.exit_code);
    assert.equal(finished.interrupt_sent, undefined);
    t.diagnostic(`Input during long poll ${inputLatency.toFixed(0)} ms; Ctrl+C ${interruptLatency.toFixed(0)} ms`);
  } finally { await runtime.dispose(); }
});

test("closed stdin treats escaped Ctrl+C as text and points to the interrupt flag", async () => {
  const runtime = new TerminalRuntime();
  try {
    const terminal = await start(runtime, node('console.log("READY"); setInterval(() => {}, 1000)'), false);
    for (const chars of ["\\u0003", "\\x03", "ordinary text\n"]) {
      await assert.rejects(runtime.write({ session_id: terminal.session_id, chars }), /stdin is closed.*interrupt=true.*tty=true/);
      const stillRunning = await runtime.write({ session_id: terminal.session_id, yield_time_ms: 0 });
      assert.equal(stillRunning.session_id, terminal.session_id);
      assert.equal(stillRunning.interrupt_sent, undefined);
      assert.equal(stillRunning.termination_reason, undefined);
    }
    const stopped = await runtime.write({ session_id: terminal.session_id, interrupt: true, yield_time_ms: 2000 });
    assert.equal(stopped.session_id, undefined);
    assert.equal(stopped.interrupt_sent, true);
    assert.equal(stopped.termination_reason, "ctrl_c");
    await assert.rejects(runtime.write({ session_id: terminal.session_id, chars: "\\u0003" }), /exited/);
  } finally { await runtime.dispose(); }
});

test("escaped Ctrl+C spellings remain ordinary TTY input", async () => {
  const runtime = new TerminalRuntime();
  try {
    const terminal = await start(runtime, shell("[Console]::WriteLine('READY'); $line=[Console]::ReadLine(); [Console]::WriteLine(\"OUT=$line\")", "printf 'READY\\n'; IFS= read -r line; printf 'OUT=%s\\n' \"$line\""), true);
    const done = await runtime.write({ session_id: terminal.session_id, chars: "\\u0003\\x03\n", yield_time_ms: 2000 });
    assert.equal(done.exit_code, 0);
    assert.equal(done.interrupt_sent, undefined);
    assert.ok(done.output.includes("OUT=\\u0003\\x03"), done.output);
  } finally { await runtime.dispose(); }
});

test("Ctrl+C after exit collects unread output without claiming an interrupt", async () => {
  const runtime = new TerminalRuntime();
  try {
    for (const tty of [false, true]) {
      // Release the command after obtaining its ID; yield_time_ms=0 can still return a fast exit.
      const release = join(cwd, randomUUID());
      const cmd = node(`const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){console.log('DONE');process.exit(7)}},10)`)
        + (windows ? "; exit $LASTEXITCODE" : "");
      const initial = await runtime.exec({ cwd, tty, cmd, yield_time_ms: 0 });
      const session_id = initial.session_id;
      assert.ok(session_id);
      await writeFile(release, "");
      const deadline = performance.now() + 5000;
      while (runtime.sessions.get(session_id)?.exitCode === null && performance.now() < deadline) await delay(10);
      assert.equal(runtime.sessions.get(session_id)?.exitCode, 7);
      const output = await runtime.write({ session_id, chars: "\u0003" });
      assert.equal(output.exit_code, 7);
      assert.equal(output.output.trim(), "DONE");
      assert.equal(output.session_id, undefined);
      assert.equal(output.interrupt_sent, undefined);
      assert.equal(output.termination_reason, undefined);
      const repeated = await runtime.write({ session_id, chars: "\u0003" });
      assert.equal(repeated.exit_code, 7);
      assert.equal(repeated.output, "");
      assert.equal(repeated.interrupt_sent, undefined);
    }
  } finally { await runtime.dispose(); }
});

test("unread flood is bounded and referenced evidence survives shutdown", async () => {
  const runtime = new TerminalRuntime();
  let logPath: string | undefined;
  try {
    const initial = await start(runtime, node("console.log('READY');setTimeout(()=>{process.stdout.write('HEAD'+ '中文😀'.repeat(800000)+'TAIL')},400)"), false);
    await delay(1200);
    const output = await runtime.write({ session_id: initial.session_id, max_output_tokens: 128 });
    assert.equal(output.exit_code, 0);
    assert.equal(output.truncated, true);
    assert.ok(output.original_token_count > 1_000_000);
    assert.match(output.output, /^HEAD.*output truncated.*TAIL$/s);
    assert.ok(!output.output.includes("�"));
    assert.ok(Buffer.byteLength(output.output) < 600);
    logPath = output.full_output_path;
    assert.ok(logPath);
    const full = await readFile(logPath, "utf8");
    assert.ok(full.includes("HEAD" + "中文😀".repeat(800000) + "TAIL"));
    const finished = await runtime.write({ session_id: initial.session_id });
    assert.equal(finished.output, "");
    assert.equal(finished.full_output_path, logPath);
  } finally { await runtime.dispose(); }
  assert.ok(logPath);
  try { assert.match(await readFile(logPath, "utf8"), /^READY\r?\nHEAD/); }
  finally { await rm(dirname(logPath), { recursive: true, force: true }); }
});

test("terminal capacity never evicts a live command", async () => {
  const runtime = new TerminalRuntime();
  try {
    const running = await runtime.exec({ cwd, cmd: node("setTimeout(() => {}, 30000)"), yield_time_ms: 0 });
    assert.ok(running.session_id);
    const existing = runtime.sessions.get(running.session_id)!;
    // Use one real job and simulate the remaining occupied slots.
    for (let id = 1; id < 64; id++) runtime.sessions.set(id, { ...existing, id });
    try {
      await assert.rejects(runtime.exec({ cwd, cmd: node(""), yield_time_ms: 0 }), /terminal_sessions.*The command did not start/);
      assert.equal(runtime.list().length, 64);
      assert.equal(runtime.sessions.get(existing.id), existing);
    } finally { for (let id = 1; id < 64; id++) runtime.sessions.delete(id); }
    assert.equal(await runtime.close(existing.id), "termination_requested");
    assert.equal(await runtime.close(existing.id), "already_closed");
  } finally { await runtime.dispose(); }
});

test("Windows normal exit preserves descendants; explicit close owns the full tree (pipe and TTY)", { skip: !windows }, async () => {
  for (const tty of [false, true]) for (const terminate of [false, true]) {
    const runtime = new TerminalRuntime();
    const nonce = `bt-test-${randomUUID()}`;
    let pid: number | undefined;
    try {
      const childCode = `/*${nonce}*/setTimeout(()=>{},20000)`;
      const cmd = node(`const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore',windowsHide:true});c.unref();console.log('CHILD='+c.pid+' READY');${terminate ? "setTimeout(()=>{},20000)" : ""}`);
      const output = terminate ? await start(runtime, cmd, tty) : await runtime.exec({ cmd, cwd, tty });
      pid = Number(output.output.match(/CHILD=(\d+)/)?.[1]);
      assert.ok(pid, output.output);
      assert.ok(alive(pid));
      if (terminate) {
        assert.ok(output.session_id);
        if (tty) await runtime.close(output.session_id);
        else {
          await assert.rejects(runtime.write({ session_id: output.session_id, chars: "unexpected\n" }), /stdin is closed/);
          const killed = await runtime.write({ session_id: output.session_id, chars: "\u0003", yield_time_ms: 2000 });
          assert.notEqual(killed.exit_code, 0);
        }
        for (let i = 0; i < 20 && alive(pid); i++) await delay(50);
        assert.equal(alive(pid), false);
      } else {
        assert.equal(output.exit_code, 0);
        assert.ok(alive(pid), "normal root exit must preserve detached descendants");
      }
    } finally {
      const disposing = performance.now();
      await runtime.dispose();
      assert.ok(performance.now() - disposing < 2000, "background descendants must not hold the bridge open");
      if (!terminate && pid) assert.ok(alive(pid), "helper shutdown must also preserve normally backgrounded descendants");
      // Pin the process handle and verify this test's unique command line before
      // cleanup; never kill an unrelated process after PID reuse.
      if (pid && alive(pid)) {
        const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){ $null=$p.Handle; $c=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($c.CommandLine.Contains(${quote(nonce)})){ $p.Kill(); $p.WaitForExit(2000) } }`;
        const cleaned = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
        assert.equal(cleaned.status, 0, cleaned.stderr.toString());
      }
    }
  }
});

test("Linux Ctrl+C, close and shutdown stop the live process group (pipe and TTY)", { skip: process.platform !== "linux" }, async () => {
  for (const tty of [false, true]) for (const action of ["interrupt", "close", "dispose"] as const) {
    const runtime = new TerminalRuntime();
    const nonce = `bt-test-${randomUUID()}`;
    const pids: number[] = [];
    try {
      const leaf = `/*${nonce}*/setTimeout(()=>{},20000)`;
      const child = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});console.log('GRANDCHILD='+c.pid);console.log('CHILD='+process.pid+' READY');setTimeout(()=>{},20000)`;
      const cmd = node(`const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});console.log('ROOT='+process.pid);setTimeout(()=>{},20000)`);
      const output = await start(runtime, cmd, tty);
      for (const name of ["ROOT", "CHILD", "GRANDCHILD"]) {
        const pid = Number(output.output.match(new RegExp(`(?:^|\\n)${name}=(\\d+)`))?.[1]);
        assert.ok(pid && alive(pid), `${tty}/${action}: ${output.output}`);
        pids.push(pid);
      }
      if (action === "interrupt") {
        const killed = await runtime.write({ session_id: output.session_id, chars: "\u0003", yield_time_ms: 2000 });
        assert.ok(killed.exit_code !== undefined && killed.exit_code !== 0, JSON.stringify(killed));
        assert.equal(killed.interrupt_sent, true);
        assert.equal(killed.termination_reason, tty ? undefined : "ctrl_c");
      } else if (action === "close") await runtime.close(output.session_id);
      else await runtime.dispose();
      for (let i = 0; i < 40 && pids.some(alive); i++) await delay(50);
      assert.ok(pids.every(pid => !alive(pid)), `${tty}/${action}: surviving PIDs ${pids.filter(alive)}`);
    } finally {
      await runtime.dispose();
      for (const pid of pids) {
        if (alive(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(nonce)) process.kill(pid, "SIGKILL");
      }
    }
  }
});

test("Linux close and shutdown stop an interactive bash foreground job in its own process group", { skip: process.platform !== "linux" }, async () => {
  for (const action of ["close", "dispose"] as const) {
    const runtime = new TerminalRuntime();
    const nonce = `bt-test-${randomUUID()}`;
    let root = 0;
    let foreground = 0;
    try {
      const initial = await start(runtime, "export PS1='INTERACTIVE_READY> '; exec bash --noprofile --norc -i", true, "INTERACTIVE_READY>");
      // Ignore the hangup from losing the shell: explicit cleanup must reach the
      // foreground process group, rather than merely closing the parent shell.
      const job = node(`/*${nonce}*/process.on('SIGHUP',()=>{});console.log('FOREGROUND='+process.pid+' READY');setTimeout(()=>{},20000)`);
      const controller = new AbortController();
      const output = await runtime.write({
        session_id: initial.session_id,
        chars: `printf 'ROOT=%s\\n' $$; ${job}\n`,
        yield_time_ms: 5000,
        signal: controller.signal,
        update: output => { if (/(?:^|\n)FOREGROUND=\d+ READY/.test(output.output)) controller.abort(); },
      });
      root = Number(output.output.match(/(?:^|\n)ROOT=(\d+)/)?.[1]);
      foreground = Number(output.output.match(/(?:^|\n)FOREGROUND=(\d+) READY/)?.[1]);
      assert.ok(root && foreground && alive(root) && alive(foreground), output.output);
      const group = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^\d+ \(.*\) /s, "").split(" ")[2]);
      assert.notEqual(group(root), group(foreground), "interactive bash must put the foreground job in a separate process group");
      if (action === "close") await runtime.close(initial.session_id);
      else await runtime.dispose();
      for (let i = 0; i < 40 && (alive(root) || alive(foreground)); i++) await delay(50);
      assert.equal(alive(root), false, `${action}: interactive bash survived`);
      assert.equal(alive(foreground), false, `${action}: foreground job survived`);
    } finally {
      await runtime.dispose();
      if (foreground && alive(foreground) && readFileSync(`/proc/${foreground}/cmdline`, "utf8").includes(nonce)) process.kill(foreground, "SIGKILL");
    }
  }
});

test("Linux bridge releases its readers while a detached descendant still holds stdout", { skip: process.platform !== "linux" }, async () => {
  for (const tty of [false, true]) {
    const runtime = new TerminalRuntime();
    const nonce = `bt-test-${randomUUID()}`;
    let pid = 0;
    try {
      const child = `/*${nonce}*/setTimeout(()=>{},20000)`;
      const cmd = node(`const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:['ignore','inherit','ignore']});c.unref();console.log('CHILD='+c.pid)`);
      const output = await runtime.exec({ cmd, cwd, tty });
      assert.equal(output.exit_code, 0);
      pid = Number(output.output.match(/CHILD=(\d+)/)?.[1]);
      assert.ok(pid && alive(pid), output.output);
      const disposing = performance.now();
      await runtime.dispose();
      assert.ok(performance.now() - disposing < 2000, "background descendants must not hold the bridge open");
      assert.ok(alive(pid), "helper shutdown preserves intentionally detached work");
    } finally {
      await runtime.dispose();
      if (pid && alive(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(nonce)) process.kill(pid, "SIGKILL");
    }
  }
});

test("real Windows SSH client: password, persistent PTY, Ctrl+C and incremental output", { skip: !windows }, async () => {
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
  const connections = new Set<import("ssh2").Connection>();
  const server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client);
    client.on("error", () => {});
    client.on("close", () => connections.delete(client));
    client.on("authentication", ctx => {
      if (ctx.method === "password" && ctx.username === "bt" && ctx.password === "bt-test-password") ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => client.on("session", accept => {
      const session = accept();
      session.on("pty", accept => accept?.());
      session.on("shell", accept => {
        const stream = accept();
        let line = "";
        stream.write("\r\nREMOTE_READY> ");
        stream.on("data", (bytes: Buffer) => {
          for (const char of bytes.toString("utf8")) {
            if (char === "\u0003") { line = ""; stream.write("\r\nINTERRUPTED> "); }
            else if (char === "\r" || char === "\n") {
              if (!line) continue;
              if (line === "exit") { stream.exit(0); stream.end(); }
              else stream.write(`\r\nREMOTE_OUT=${line}\r\nREMOTE> `);
              line = "";
            } else line += char;
          }
        });
      });
    }));
  });
  const runtime = new TerminalRuntime();
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cmd = `ssh.exe -F NUL -o UserKnownHostsFile=NUL -o StrictHostKeyChecking=no -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o ConnectTimeout=4 -tt -p ${address.port} bt@127.0.0.1`;
    const initial = await start(runtime, cmd, true, "password:");
    const login = await runtime.write({ session_id: initial.session_id, chars: "bt-test-password\n", yield_time_ms: 2000 });
    assert.ok(login.output.includes("REMOTE_READY"), login.output);
    assert.ok(!login.output.includes("bt-test-password"));
    let firstVisible!: () => void;
    const visible = new Promise<void>(resolve => { firstVisible = resolve; });
    const collecting = runtime.write({ session_id: initial.session_id, chars: "first\n", yield_time_ms: 5000,
      update: output => { if (output.output.includes("REMOTE_OUT=first")) firstVisible(); },
    });
    await Promise.race([visible, collecting.then(() => { throw new Error("SSH response was not streamed"); })]);
    const interrupting = performance.now();
    const [first, interrupt] = await Promise.all([collecting, runtime.write({ session_id: initial.session_id, chars: "\u0003", yield_time_ms: 500 })]);
    assert.ok(performance.now() - interrupting < 1500, "TTY Ctrl+C must yield a command-response collector, not just pure polls");
    assert.ok(first.output.includes("REMOTE_OUT=first"), first.output);
    assert.ok(!first.output.includes("REMOTE_READY") && !first.output.includes("INTERRUPTED"));
    assert.ok(interrupt.output.includes("INTERRUPTED"), interrupt.output);
    assert.equal(interrupt.session_id, initial.session_id);
    assert.equal(interrupt.interrupt_sent, true);
    const second = await runtime.write({ session_id: initial.session_id, chars: "second\n", yield_time_ms: 500 });
    assert.ok(second.output.includes("REMOTE_OUT=second"));
    assert.ok(!second.output.includes("REMOTE_OUT=first"));
    const done = await runtime.write({ session_id: initial.session_id, chars: "exit\n", yield_time_ms: 2000 });
    assert.equal(done.exit_code, 0, done.output);
    assert.equal(interrupt.termination_reason, undefined);
    assert.equal(done.termination_reason, undefined);
    assert.equal(done.interrupt_sent, undefined);
  } finally {
    await runtime.dispose();
    for (const connection of connections) connection.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("pi-prime integration preserves running terminals and referenced logs across reload", async t => {
  const agentDir = join(cwd, "agent");
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "edit", "write", "bash", "powershell", "codemode"], extensions: ["-builtin:codemode"] });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    extensionFactories: [{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true }, pi => {
      pi.registerTool({
        name: "probe", label: "Probe", description: "Test nested tool visibility.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
          assert.ok(!ctx.tools.some(tool => tool.name === "bash" || tool.name === "powershell"));
          return { content: [{ type: "text", text: "OK" }], details: undefined };
        },
      });
    }],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  assert.deepEqual(loader.getExtensions().warnings, []);
  const codemodeDefinitions = () => loader.getExtensions().extensions.flatMap(extension => [...extension.tools.values()])
    .filter(tool => tool.definition.name === "codemode");
  assert.equal(codemodeDefinitions().length, 1);
  const model = { provider: "test", api: "openai-completions" as const, id: "gpt-terminal-test", name: "Terminal test",
    baseUrl: "http://127.0.0.1", reasoning: false, input: ["text" as const], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), model });
  const errors: unknown[] = [];
  try {
    await session.bindExtensions({ onError: error => errors.push(error) });
    assert.deepEqual(errors, []);
    const active = session.getActiveToolNames();
    assert.ok(active.includes("exec_command") && active.includes("write_stdin"));
    assert.ok(!active.includes("bash") && !active.includes("powershell"));
    session.setActiveToolsByName([...active, "bash", "powershell"]);
    assert.deepEqual(session.getActiveToolNames(), active);
    const tools = session.getAllTools();
    assert.equal(tools.find(tool => tool.name === "bash")?.exposure, "hidden");
    assert.equal(tools.find(tool => tool.name === "powershell")?.exposure, "hidden");
    initTheme("dark", false);
    const definition = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.values()]).find(tool => tool.definition.name === "exec_command")?.definition;
    assert.ok(definition?.renderCall);
    const ui = { requestRender() {} } as ConstructorParameters<typeof ToolExecutionComponent>[5];
    const preview = new ToolExecutionComponent("exec_command", "preview", {}, undefined, definition, ui, cwd);
    assert.equal(definition.label, windows ? "PowerShell" : "Bash");
    assert.match(definition.description, windows ? /PowerShell 7/ : /bash/i);
    assert.match(definition.promptSnippet!, windows ? /PowerShell/ : /bash/i);
    assert.match(JSON.stringify(definition.parameters), windows ? /PowerShell script/ : /bash script/i);
    const prompt = windows ? "PS>" : "$";
    assert.ok(preview.render(80).map(stripVTControlCharacters).join("\n").includes(prompt));
    preview.updateArgs({ cmd: shell('Get-Location\n"中文 引号"', 'pwd\nprintf "%s\\n" "中文 引号"'), workdir: shell("C:/with space", "/with space"), tty: true });
    const rendered = preview.render(80).map(stripVTControlCharacters).join("\n");
    assert.match(rendered, windows ? /PS> Get-Location +C:\/with space  TTY/ : /\$ pwd +\/with space  TTY/);
    assert.ok(rendered.includes('"中文 引号"') && !rendered.includes("cmd="), rendered);
    const exec = session.agent.state.tools.find(tool => tool.name === "exec_command");
    assert.ok(exec);
    const jsonFailure = await exec.execute("json-log-before-failure", {
      cmd: `${node('console.log(JSON.stringify({step:"init",ok:true})); console.error("FATAL: fixture failure"); process.exit(7)')}${windows ? "; exit $LASTEXITCODE" : ""}`,
    });
    assert.equal(jsonFailure.isError, true);
    assert.equal((jsonFailure.structuredContent as TerminalOutput).exit_code, 7);
    const failureText = jsonFailure.content.filter(item => item.type === "text").map(item => item.text).join("\n");
    assert.match(failureText, /^Exit 7\n/);
    assert.match(failureText, /\{"step":"init","ok":true\}/);
    assert.match(failureText, /FATAL: fixture failure/);
    if (windows) {
      const checked = await exec.execute("powershell-test-and-inspection", {
        cmd: `${node("process.exit(7)")}; $testExit = $LASTEXITCODE; Get-Item -LiteralPath . | Select-Object Name | Out-String; exit $testExit`,
      });
      const status = checked.structuredContent as TerminalOutput;
      assert.equal(status.exit_code, 7);
      assert.match(status.output, /pi-prime-terminal-/);
    }
    const sessionsTool = session.agent.state.tools.find(tool => tool.name === "terminal_sessions");
    assert.ok(sessionsTool);
    await assert.rejects(sessionsTool.execute("invalid-close", { action: "close" }), /requires session_id/);
    const managed = await exec.execute("managed", { cmd: node('setInterval(() => {}, 1000)'), yield_time_ms: 0 });
    const managedId = (managed.structuredContent as TerminalOutput).session_id;
    assert.ok(managedId);
    // Cancellation before launch, or before input reaches a session, says that nothing happened.
    const sessionIds = async () => ((await sessionsTool.execute("ids", {})).structuredContent as { sessions: { session_id: number }[] }).sessions.map(s => s.session_id);
    const idsBefore = await sessionIds();
    await assert.rejects(exec.execute("cancelled-launch", { cmd: node("") }, AbortSignal.abort()), /Cancelled before launch; the command did not start\./);
    const writeTool = session.agent.state.tools.find(tool => tool.name === "write_stdin")!;
    await assert.rejects(writeTool.execute("cancelled-input", { session_id: managedId, chars: "x" }, AbortSignal.abort()), new RegExp(`Cancelled before reaching session ${managedId}; no input was sent\\.`));
    assert.deepEqual(await sessionIds(), idsBefore);
    const listed = await sessionsTool.execute("list", {});
    assert.ok((listed.structuredContent as { sessions: { session_id: number }[] }).sessions.some(s => s.session_id === managedId));
    const closed = await sessionsTool.execute("close", { action: "close", session_id: managedId });
    assert.equal((closed.structuredContent as { closed_session_id: number }).closed_session_id, managedId);
    assert.equal((closed.structuredContent as { close_status: string }).close_status, "termination_requested");
    const output = await exec.execute("integration", { cmd: shell("'PI_READY'; 1..120 | ForEach-Object { 'line-{0:D3} 中文 sample output' -f $_ }", "printf 'PI_READY\\n'; printf 'line-%03d 中文 sample output\\n' {1..120}"), max_output_tokens: 128 });
    const structured = output.structuredContent as TerminalOutput;
    assert.ok(structured.output.includes("PI_READY"));
    assert.equal(structured.exit_code, 0);
    assert.ok(structured.full_output_path);
    assert.ok(!structured.output.includes(structured.full_output_path));
    assert.equal(output.details, structured, "codemode and renderers share the same clean output");
    assert.ok(output.content.some(block => block.type === "text" && block.text.includes(structured.full_output_path!)));
    const full = await readFile(structured.full_output_path, "utf8");
    assert.ok(full.includes("line-060 中文 sample output"));
    assert.ok(full.includes("line-120 中文 sample output"));

    const codemode = session.agent.state.tools.find(tool => tool.name === "codemode");
    assert.ok(codemode);
    session.agent.state.messages.push({
      role: "assistant", content: [], api: "openai-responses", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: Date.now(),
    });
    const unchangedFile = join(cwd, "noop.txt");
    await writeFile(unchangedFile, "unchanged");
    const noop = await codemode.execute("noop-then-error", { code: `
      await tools.edit({path: ${JSON.stringify(unchangedFile)}, edits:[{oldText:"unchanged", newText:"unchanged"}]});
      throw Error("script stopped");
    ` });
    assert.equal(noop.isError, true);
    assert.match(JSON.stringify(noop.content), /no write needed.*noop\.txt/);
    assert.doesNotMatch(JSON.stringify(noop.content), /file action completed/);
    assert.equal(await readFile(unchangedFile, "utf8"), "unchanged");
    const settled = await codemode.execute("settled-errors", { code: `text(await Promise.allSettled([
      tools.read({ path: ${JSON.stringify(join(cwd, "missing.txt"))} }),
      tools.exec_command({ cmd: "exit 7" }),
    ]));` });
    assert.equal(settled.isError, undefined, JSON.stringify(settled.content));
    assert.doesNotMatch(JSON.stringify(settled.content), /Nested tool outcomes/);
    const values = JSON.parse((settled.content[1] as { text: string }).text);
    assert.equal(values[0].status, "rejected");
    assert.equal(values[0].reason.name, "Error");
    assert.match(values[0].reason.message, /ENOENT/);
    assert.equal(values[1].value.exit_code, 7);
    assert.equal(values[1].value.output, "");
    // An oversized wait still launches or collects the command and reports its actual exit status.
    const silent = await codemode.execute("silent-failure", { code: 'await tools.exec_command({cmd:"exit 7",yield_time_ms:600000});' });
    assert.equal(silent.isError, undefined, JSON.stringify(silent.content));
    assert.match((silent.content[0] as { text: string }).text, /^Script completed\n/);
    assert.doesNotMatch(JSON.stringify(silent.content), /Nested tool outcomes|exited with code 7/);
    for (const exitCode of [0, 7]) {
      const finished = await codemode.execute("poll-to-exit-" + exitCode, { code:
        "const job = await tools.exec_command(" + JSON.stringify({ cmd: "exit " + exitCode, yield_time_ms: 0 }) + ");\n" +
        "text(job.session_id ? await tools.write_stdin({session_id:job.session_id,yield_time_ms:600000}) : job);",
      });
      assert.equal(finished.isError, undefined, JSON.stringify(finished.content));
      assert.equal(JSON.parse((finished.content[1] as { text: string }).text).exit_code, exitCode);
      assert.doesNotMatch(JSON.stringify(finished.content), /process still running|use tools\.write_stdin/);
      assert.doesNotMatch(JSON.stringify(finished.content), /Nested tool outcomes/);
    }
    const closedInScript = await codemode.execute("close-in-script", { code:
      "const jobs = await Promise.all([0,1].map(() => tools.exec_command(" +
      JSON.stringify({ cmd: node("setTimeout(() => {}, 10000)"), yield_time_ms: 0 }) + ")));\n" +
      "text({ids:jobs.map(job => job.session_id),closed:await tools.terminal_sessions({action:'close',session_id:jobs[0].session_id})});",
    });
    assert.equal(closedInScript.isError, undefined, JSON.stringify(closedInScript.content));
    const { ids } = JSON.parse((closedInScript.content[1] as { text: string }).text) as { ids: number[] };
    const outcomes = closedInScript.content.flatMap(item => item.type === "text" && item.text.startsWith("Nested tool outcomes") ? [item.text] : []).join("\n");
    assert.ok(!outcomes.includes("session_id:" + ids[0]), outcomes);
    assert.ok(outcomes.includes("session_id:" + ids[1]), outcomes);
    await sessionsTool.execute("close-other-job", { action: "close", session_id: ids[1] });
    // Normal yields consume output too. Recover it when the parent fails after the call returned.
    const returned = await codemode.execute("returned-before-error", { code: `
let r = await tools.exec_command({cmd:${JSON.stringify(node('console.log("RECOVERY_EARLY");setTimeout(()=>console.log("RECOVERY_LATE"),3500)'))},yield_time_ms:500});
while (r.session_id && !r.output.includes("RECOVERY_EARLY")) r = await tools.write_stdin({session_id:r.session_id,yield_time_ms:500});
if (!r.session_id) throw new Error("fixture exited before the ordinary yield");
JSON.parse("{"); text(r);` });
    assert.equal(returned.isError, true);
    const recovery = returned.content.filter(item => item.type === "text" && item.text.startsWith("Nested tool outcomes"));
    assert.equal(recovery.length, 1, JSON.stringify(returned.content));
    const recovered = (recovery[0] as { text: string }).text;
    assert.match(recovered, /RECOVERY_EARLY/);
    assert.doesNotMatch(recovered, /"cancelled":true/);
    const returnedId = /"session_id":(\d+)/.exec(recovered)?.[1];
    assert.ok(returnedId, recovered);
    const remainder = await writeTool.execute("after-ordinary-yield", { session_id: Number(returnedId), yield_time_ms:5000 });
    assert.equal((remainder.structuredContent as TerminalOutput).exit_code, 0);
    assert.match((remainder.structuredContent as TerminalOutput).output, /RECOVERY_LATE/);
    assert.doesNotMatch((remainder.structuredContent as TerminalOutput).output, /RECOVERY_EARLY/);
    for (const exitCode of [0, 7]) {
      const done: AgentToolResult<unknown> = await codemode.execute(`completed-before-error-${exitCode}`, { code: `
await tools.exec_command({cmd:${JSON.stringify(node(`console.log("RECOVERY_COMPLETE_${exitCode}");process.exit(${exitCode})`) + (windows ? "; exit $LASTEXITCODE" : ""))}});
throw new Error("parent failed after command finished");` });
      const saved = done.content.filter(item => item.type === "text" && item.text.startsWith("Nested tool outcomes"));
      assert.equal(saved.length, 1, JSON.stringify(done.content));
      assert.match((saved[0] as { text: string }).text, new RegExp(`RECOVERY_COMPLETE_${exitCode}`));
      assert.match((saved[0] as { text: string }).text, new RegExp(`"exit_code":${exitCode}`));
    }
    const large = await codemode.execute("large-returned-before-error", { code: `
await tools.exec_command({cmd:${JSON.stringify(node('for(let i=0;i<400;i++)console.log("RECOVERY_LINE_"+i+"_中文_"+"x".repeat(20))'))},max_output_tokens:10000});
throw new Error("parent failed with a large returned result");` });
    const largeRecovery = large.content.find(item => item.type === "text" && item.text.startsWith("Nested tool outcomes")) as { text: string };
    assert.ok(largeRecovery && largeRecovery.text.length < 2500, JSON.stringify(large.content));
    const recoveryPath = /Read the complete results at (.+)\.\nPreview:/.exec(largeRecovery.text)?.[1];
    assert.ok(recoveryPath, largeRecovery.text);
    assert.ok(dirname(recoveryPath).startsWith(join(artifactsRoot, "codemode-")));
    t.after(() => rm(dirname(recoveryPath), { recursive: true, force: true }));
    const savedOutput = await readFile(recoveryPath, "utf8");
    for (const line of [0, 199, 399]) assert.ok(savedOutput.includes(`RECOVERY_LINE_${line}_中文_`));
    const statusOnly = await codemode.execute("status-only-before-error", { code: `
await tools.exec_command({cmd:${JSON.stringify(node('console.log("STATUS_ONLY_RECOVERY")'))},max_output_tokens:0});
throw new Error("parent failed after a status-only call");` });
    const statusRecovery = statusOnly.content.find(item => item.type === "text" && item.text.startsWith("Nested tool outcomes")) as { text: string };
    assert.ok(statusRecovery, JSON.stringify(statusOnly.content));
    const statusLine = statusRecovery.text.split("\n").find(line => line.startsWith('{"wall_time_seconds":'));
    assert.ok(statusLine, statusRecovery.text);
    assert.match(await readFile(JSON.parse(statusLine).full_output_path, "utf8"), /STATUS_ONLY_RECOVERY/);
    const timedScript = `// @options: {"timeout_ms":2000}
await tools.exec_command({cmd:${JSON.stringify(node('setTimeout(() => console.log("recovered-worker"), 3500)'))}});`;
    t.mock.method(session.modelRuntime, "checkAuth", async () => ({ type: "api_key" }));
    for (const selected of [model, { ...model, id: "deepseek-flash" }]) {
      if (selected !== model) await session.setModel(selected);
      const timed: AgentToolResult<unknown> = await codemode.execute("terminal-timeout", { code: timedScript });
      assert.equal(timed.isError, true);
      assert.match((timed.content[0] as { text: string }).text, /^Script failed\n/);
      const summary = timed.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      assert.match(summary, /exec_command.*wait stopped; process may still be running/);
      assert.doesNotMatch(summary, /no final receipt/);
      const errorText = timed.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      assert.match(errorText, /exec_command \[[^\]]+\] \(wait stopped\)/);
      assert.doesNotMatch(errorText, /exec_command \[[^\]]+\] \(cancelled\)/);
      const route = selected === model ? /In codemode, use tools\.write_stdin\(\{session_id:(\d+)\}\)/ : /Call write_stdin\(\{session_id:(\d+)\}\)/;
      const sessionId = route.exec(summary)?.[1];
      assert.ok(sessionId, JSON.stringify(timed.content));
      assert.ok((await sessionsTool.execute("after-timeout", {})).content.some(item => item.type === "text" && item.text.includes(sessionId)));
      const poll = session.agent.state.tools.find(tool => tool.name === "write_stdin")!;
      const collected = await poll.execute("collect-timeout", { session_id: Number(sessionId), yield_time_ms: 5000 });
      const finished = collected.structuredContent as TerminalOutput;
      assert.equal(finished.exit_code, 0);
      assert.match(finished.output, /recovered-worker/);
      const repeated = await poll.execute("poll-completed", { session_id: Number(sessionId) });
      assert.equal((repeated.structuredContent as TerminalOutput).output, "");
    }
    await session.setModel(model);
    const background = await codemode.execute("background", { code: `await tools.exec_command({cmd:${JSON.stringify(node("setTimeout(() => {}, 10000)"))},yield_time_ms:0});` });
    const backgroundId = /tools\.write_stdin\(\{session_id:(\d+)\}\)/.exec((background.content[1] as { text: string }).text)?.[1];
    assert.ok(backgroundId, JSON.stringify(background.content));
    await sessionsTool.execute("close-background", { action: "close", session_id: Number(backgroundId) });
    const nested = await codemode.execute("nested", { code: `// @options: {"max_output_tokens": 64}
const r = await tools.exec_command(${JSON.stringify({ cmd: shell("1..120 | ForEach-Object { 'nested-{0:D3}' -f $_ }", "printf 'nested-%03d\\n' {1..120}"), max_output_tokens: 128 })}); text(r);` });
    const outerLog = (nested.details as { fullOutputPath?: string }).fullOutputPath;
    assert.ok(outerLog, JSON.stringify(nested.content));
    t.after(() => rm(outerLog, { force: true }));
    const baseCodemode = codemodeDefinitions()[0]!.definition;
    const renderers = session.extensionRunner.resolveToolRenderers("codemode", () => baseCodemode);
    const nestedPreview = new ToolExecutionComponent("codemode", "nested", { code: "" }, undefined, { ...baseCodemode, ...renderers }, ui, cwd);
    nestedPreview.updateResult({ ...nested, isError: nested.isError ?? false });
    assert.match(nestedPreview.render(80).map(stripVTControlCharacters).join("\n"), windows ? /PS> 1\.\.120/ : /\$ printf 'nested-/);
    const pathLine = (await readFile(outerLog, "utf8")).split("\n").find(line => line.startsWith('{"wall_time_seconds":'));
    assert.ok(pathLine, "text(r) must retain the inner full-output path and terminal status");
    const nestedLog = JSON.parse(pathLine).full_output_path as string;
    assert.match(await readFile(nestedLog, "utf8"), /nested-060/);

    const quiet = await exec.execute("quiet", { cmd: shell("$null", ":") });
    assert.equal((quiet.structuredContent as TerminalOutput).output, "");
    assert.deepEqual(quiet.content, [{ type: "text", text: "Exit 0" }]);
    assert.equal(quiet.details, quiet.structuredContent);
    const stdin = session.agent.state.tools.find(tool => tool.name === "write_stdin");
    assert.ok(stdin);
    const stdinDefinition = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.values()]).find(tool => tool.definition.name === "write_stdin")!.definition;
    assert.doesNotMatch((stdinDefinition.promptGuidelines ?? []).join("\n"), /codemode|text\(r\)/);
    for (const tty of [false, true]) {
      const background = await exec.execute("background", { cmd: shell("Start-Sleep -Seconds 30", "sleep 30"), tty, yield_time_ms: 0 });
      const stopped = await stdin.execute("stop", { session_id: (background.structuredContent as TerminalOutput).session_id!, chars: "\u0003", yield_time_ms: 2000 });
      const status = stopped.structuredContent as TerminalOutput;
      assert.ok(status.exit_code !== undefined && status.exit_code !== 0);
      assert.equal(status.termination_reason, tty ? undefined : "ctrl_c");
      assert.equal(status.interrupt_sent, true);
      assert.ok(stopped.content.some(block => block.type === "text" && block.text.includes(tty ? `Exit ${status.exit_code} · Ctrl+C sent` : `Terminated (Ctrl+C) · exit ${status.exit_code}`)));
    }
    const probe = session.agent.state.tools.find(tool => tool.name === "probe");
    assert.ok(probe);
    await probe.execute("nested-visibility", {});
    const pending = await exec.execute("reload", { cmd: shell("[Console]::WriteLine($PID); Start-Sleep -Seconds 30", "printf '%s\\n' $$; sleep 30"), yield_time_ms: 1000 });
    const running = pending.structuredContent as TerminalOutput;
    const pid = Number(running.output.trim());
    assert.ok(running.session_id && pid && alive(pid));
    const timers = t.mock.method(globalThis, "setTimeout");
    await session.reload();
    assert.ok(timers.mock.calls.some(call => call.arguments[1] === 30_000 && call.result?.hasRef() === false));
    timers.mock.restore();
    assert.deepEqual(errors, []);
    assert.equal(codemodeDefinitions().length, 1);
    assert.ok(alive(pid));
    assert.equal(await readFile(structured.full_output_path, "utf8"), full);
    assert.match(await readFile(nestedLog, "utf8"), /nested-060/);
    assert.equal(await readFile(recoveryPath, "utf8"), savedOutput);
    const reopenedSessions = session.agent.state.tools.find(tool => tool.name === "terminal_sessions")!;
    const resumed = await reopenedSessions.execute("list-after-reload", {});
    assert.match(JSON.stringify(resumed.structuredContent), new RegExp(`"session_id":${running.session_id}`));
    await reopenedSessions.execute("close-after-reload", { action: "close", session_id: running.session_id });
    const reloadedExec = session.agent.state.tools.find(tool => tool.name === "exec_command");
    assert.ok(reloadedExec);
    const reloaded = await reloadedExec.execute("reloaded", { cmd: shell("'RELOADED'", "printf 'RELOADED\\n'") });
    assert.equal((reloaded.structuredContent as TerminalOutput).output.trim(), "RELOADED");
    t.after(() => rm(dirname(structured.full_output_path!), { recursive: true, force: true }));
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});

test("default terminal output budget retains 24KB cleanly and truncates 40KB with a log", async () => {
  const runtime = new TerminalRuntime();
  let logPath: string | undefined;
  try {
    const withinBudget = await runtime.exec({ cwd, cmd: node("process.stdout.write('START_' + 'a'.repeat(24000) + '_END')") });
    assert.equal(withinBudget.exit_code, 0);
    assert.equal(withinBudget.truncated, undefined);
    assert.match(withinBudget.output, /^START_a+_END$/);

    const overBudget = await runtime.exec({ cwd, cmd: node("process.stdout.write('HEAD_' + 'b'.repeat(40000) + '_TAIL')") });
    assert.equal(overBudget.exit_code, 0);
    assert.equal(overBudget.truncated, true);
    assert.match(overBudget.output, /^HEAD_.*output truncated.*_TAIL$/s);
    logPath = overBudget.full_output_path;
    assert.ok(logPath);
  } finally {
    await runtime.dispose();
    if (logPath) await rm(dirname(logPath), { recursive: true, force: true });
  }
});
