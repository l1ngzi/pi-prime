import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, initTheme, SessionManager, SettingsManager, ToolExecutionComponent, type AgentToolResult, type ExtensionAPI, type ToolDefinition, type ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import codemode from "../src/codemode.ts";
import terminal from "../src/terminal/index.ts";
import { archiveText, artifactDirectory } from "../src/artifacts.ts";
import { compactArgumentError, toolErrorHint } from "../src/tool-diagnostics.ts";

initTheme("dark", false);

let builtin!: ToolDefinition;
let resolveRenderers!: ToolRendererResolver;
const pi: Pick<ExtensionAPI, "registerTool" | "registerToolRenderer" | "getAllTools" | "on"> = {
  on: () => () => {},
  registerTool: tool => { builtin = tool as ToolDefinition; },
  registerToolRenderer: resolver => { resolveRenderers = resolver; },
  getAllTools: () => [],
};
await createCodemodeExtension()(pi as ExtensionAPI);
const original = builtin;
codemode(pi as ExtensionAPI);
const tool = { ...builtin, ...resolveRenderers("codemode", () => builtin) };

function render(content: AgentToolResult<unknown>["content"], calls: unknown[], expanded = false, isError = false) {
  const ui = { requestRender() {} } as ConstructorParameters<typeof ToolExecutionComponent>[5];
  const view = new ToolExecutionComponent("codemode", "test", { code: "" }, undefined, tool, ui, process.cwd());
  view.updateResult({ content: [{ type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" }, ...content], details: { calls }, isError, durationMs: 1200 });
  view.setExpanded(expanded);
  return view;
}
const plain = (view: ToolExecutionComponent, width = 80) => view.render(width).map(line => stripVTControlCharacters(line).trimEnd().replace(/^ /, "")).join("\n");
const out = (fields: Record<string, unknown>) => JSON.stringify({ wall_time_seconds: 0.42, output: "", original_token_count: 1, ...fields });

test("codemode output defaults leave nested tool parameters and descriptions intact", () => {
  const definitions = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Function>();
  let active = ["codemode", "exec_command", "write_stdin"];
  const api = {
    on: (name: string, handler: Function) => { handlers.set(name, handler); return () => {}; },
    registerTool: (definition: ToolDefinition) => definitions.set(definition.name, definition),
    registerToolRenderer() {}, registerCommand() {},
    getSettings: () => ({ codemode: { inlineBudget: 20000 } }),
    getAllTools: () => [...definitions.values()].map(tool => ({ ...tool, exposure: tool.exposure ?? "direct" })),
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
  } as unknown as ExtensionAPI;
  terminal(api);
  codemode(api);
  handlers.get("model_select")!({}, { model: { id: "gpt-offline" } });
  const script = definitions.get("codemode")!;
  const nested = ["exec_command", "write_stdin"].map(name => definitions.get(name)!);
  const prepared = script.prepareLoadout!({
    declared: [script, ...nested], callable: nested,
    getExposure: () => "direct", getNamespace: () => undefined, getPromptGuidelines: () => [],
  } as never);
  const description = prepared!.descriptions!.codemode;
  assert.match(description, /"max_output_tokens": 10000/);
  assert.match(description, /timeout_ms for a script-wide deadline/);
  const parameters = nested[0].parameters as unknown as { properties: { yield_time_ms: { description: string } } };
  assert.ok(description.includes(parameters.properties.yield_time_ms.description));
});

test("nested terminal calls read like terminal cards", () => {
  const view = render([], [
    { id: "a", name: "exec_command", args: JSON.stringify({ cmd: "git status\ngit log -1", tty: true }), status: "ok", durationMs: 1234 },
    { id: "b", name: "write_stdin", args: JSON.stringify({ session_id: 3, chars: "yes\n" }), status: "ok", durationMs: 310 },
    { id: "c", name: "write_stdin", args: JSON.stringify({ session_id: 3, chars: "\x03" }), status: "error" },
    { id: "d", name: "write_stdin", args: JSON.stringify({ session_id: 3 }), status: "running" },
    { id: "e", name: "exec_command", args: JSON.stringify({ cmd: "Write-Output " + "\\\"x".repeat(120) }).slice(0, 197) + "...", status: "cancelled" },
    { id: "f", name: "read", args: JSON.stringify({ path: "a.ts" }), status: "ok", durationMs: 5 },
  ]);
  const text = plain(view);
  assert.match(text, process.platform === "win32" ? /✓ PS> git status \+1 lines TTY 1\.2s/ : /✓ \$ git status \+1 lines TTY 1\.2s/);
  assert.match(text, /✓ #3 › yes ⏎ +310ms/);
  assert.match(text, /✗ #3 \^C interrupt/);
  assert.match(text, /… #3 ⋯ collect output/);
  assert.match(text, process.platform === "win32" ? /⊘ PS> Write-Output\s+\\"x/ : /⊘ \$ Write-Output\s+\\"x/);
  assert.match(text, /✓ read \{"path":"a\.ts"\} 5ms/);
  for (const width of [20, 40]) for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width);
});

test("numbered codemode output keeps terminal cards and the native timer", async () => {
  const items = [
    "Checking build",
    JSON.parse(out({ output: "On branch main\r\nnothing to commit\n", exit_code: 0 })),
    [
      { status: "fulfilled", value: JSON.parse(out({ output: "boom", exit_code: 1 })) },
      { status: "rejected", reason: { name: "Error", message: "unknown session_id: 9" } },
    ],
    { server: JSON.parse(out({ session_id: 4, output: "listening on :8080" })) },
    { files: ["a.ts", "b.ts"], count: 2 },
    "done",
  ];
  const code = items.map(item => `text(${JSON.stringify(item)});`).join("\n");
  const output = await builtin.execute("test", { code }, undefined, undefined, undefined as never);
  assert.equal(output.isError, undefined, JSON.stringify(output.content));
  const view = render(output.content.slice(1), [], true);
  const text = plain(view);
  assert.ok(!text.includes("wall_time_seconds"));
  assert.match(text, /Checking build\n==> text 2\/6 <==\n✓ exit 0 · 0\.4s\nOn branch main\nnothing to commit/);
  assert.match(text, /\[0\]  ✗ exit 1 · 0\.4s\nboom\n\n\[1\]  ✗ unknown session_id: 9/);
  assert.match(text, /server  ◐ #4 running · 0\.4s\nlistening on :8080/);
  assert.match(text, /\{\n  "files": \[\n    "a\.ts",/);
  assert.match(text, /done\n+Took 1\.2s/);

  view.setExpanded(false);
  const collapsed = plain(view);
  assert.match(collapsed, /more lines, .*to expand/);
  assert.ok(collapsed.includes("✓ exit 0") && !collapsed.includes("listening"));
});

test("terminal-like JSON keeps invalid states and extra metadata intact", () => {
  const result = JSON.parse(out({ output: "done", exit_code: 0 }));
  for (const value of [
    { wall_time_seconds: 1, output: "done", files: ["a", "b"] },
    JSON.parse(out({ output: "done" })),
    { ...result, files: ["a", "b"] },
    { ...result, exit_code: "0" },
    JSON.parse(out({ session_id: 0 })),
    { ...result, session_id: 3 },
    [{ status: "fulfilled", value: result, metadata: "keep me" }],
    [{ status: "rejected", reason: { message: "failed" }, metadata: "keep me" }],
    [{ status: "rejected", reason: { message: "failed", code: 123 } }],
  ]) {
    const text = plain(render([{ type: "text", text: JSON.stringify(value) }], [], true));
    assert.ok(text.includes(JSON.stringify(value, null, 2)), text);
  }
});

test("nested and shared Error output retains name, message, cause and custom fields", async () => {
  const output = await builtin.execute("errors", { code: `
    const error = Object.assign(new TypeError("bad input", { cause: new Error("root cause") }), { code: "INVALID" });
    text(await Promise.allSettled([Promise.reject(error), Promise.resolve(error)]));
  ` }, undefined, undefined, undefined as never);
  assert.equal(output.isError, undefined, JSON.stringify(output.content));
  const values = JSON.parse((output.content[1] as { text: string }).text);
  const expected = { code: "INVALID", name: "TypeError", message: "bad input", cause: { name: "Error", message: "root cause" } };
  assert.deepEqual(values, [
    { status: "rejected", reason: expected },
    { status: "fulfilled", value: expected },
  ]);
  const logged = await builtin.execute("logged-error", { code: 'console.error({ reason: new Error("logged") });' }, undefined, undefined, undefined as never);
  assert.match((logged.content[1] as { text: string }).text, /"reason":\{"name":"Error","message":"logged"\}/);
});

test("archived tool previews inside codemode keep one complete spill file without outer truncation", async t => {
  const page = "PAGE_BEGIN" + "x".repeat(40000) + "PAGE_END";
  const definitions = new Map<string, ToolDefinition>();
  const api = { on: () => () => {}, registerTool: (tool: ToolDefinition) => definitions.set(tool.name, tool),
    registerToolRenderer() {}, getAllTools: () => [...definitions.values()], getActiveTools: () => ["codemode"],
  } as unknown as ExtensionAPI;
  codemode(api);
  const fetchTool: ToolDefinition = {
    name: "doc_fetch", label: "Doc Fetch", description: "Fetch a large document.", exposure: "deferred",
    parameters: Type.Object({ url: Type.String() }),
    async execute() {
      const saved = await archiveText("codemode", "response.txt", page);
      t.after(async () => { await rm(saved.path, { force: true }); await rmdir(dirname(saved.path)); });
      return {
        content: [{ type: "text", text: `${page.slice(0, 8000)}\n\n[Preview only. Read the complete result at ${saved.path}.]` }],
        details: undefined,
      };
    },
  };
  definitions.set(fetchTool.name, fetchTool);
  const ctx = { tools: [fetchTool], sessionManager: { getBranch: () => [] },
    executeTool: async (_name: string, args: unknown) => {
      const result = await fetchTool.execute("doc", args as { url: string }, undefined, undefined, undefined as never);
      return { toolCall: { id: "doc" }, result, isError: false };
    },
  };
  const result = await definitions.get("codemode")!.execute("doc-preview", {
    code: 'text(await tools.doc_fetch({url:"https://example.com/source"}));',
  }, undefined, undefined, ctx as never);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const spill = (result.details as { fullOutputPath?: string }).fullOutputPath;
  if (spill) t.after(() => rm(spill, { force: true }));
  assert.equal(spill, undefined);
  const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const path = /Read the complete result at (.+)\.\]/.exec(text)?.[1];
  assert.ok(path, text);
  assert.equal(text.split("Preview only").length - 1, 1);
  assert.doesNotMatch(text, /Warning: truncated output/);
  assert.ok((await readFile(path, "utf8")).includes(page));
});

test("ordinary text and console formatting stays identical to bundled codemode", async () => {
  const code = `
    const values = [undefined, null, NaN, Infinity, -Infinity, 7n, new Date("2026-01-01"), { toJSON() { return "custom"; } }, [1, "two"]];
    for (const value of values) { text(value); console.log(value); }
    const circular = {}; circular.self = circular; console.warn(circular);
    const error = new Error("failure"); error.cause = error;
    console.error({ reason: error });
    text("completed");
    text("keep this literal: …123 tokens truncated… unchanged");
  `;
  const before = await original.execute("before", { code }, undefined, undefined, undefined as never);
  const after = await builtin.execute("after", { code }, undefined, undefined, undefined as never);
  assert.equal(after.isError, undefined, JSON.stringify(after.content));
  assert.deepEqual(after.content.slice(1), before.content.slice(1));
  const resilient = await builtin.execute("cyclic-and-bigint-output", { code: `
    const circular = { label: "node" }; circular.self = circular;
    const cyclicError = new Error("loop"); cyclicError.cause = cyclicError;
    text({ circular, reason: cyclicError, count: 7n });
    return { returned: circular, count: 9n };
  ` }, undefined, undefined, undefined as never);
  assert.equal(resilient.isError, undefined, JSON.stringify(resilient.content));
  const sections = (resilient.content[1] as { text: string }).text.split(/^==> text \d+\/\d+ <==\n/m).filter(Boolean);
  const emitted = JSON.parse(sections[0].trim());
  assert.equal(emitted.circular.self, "[Circular]");
  assert.equal(emitted.reason.message, "loop");
  assert.equal(emitted.reason.cause, "[Circular]");
  assert.equal(emitted.count, "7n");
  const returned = JSON.parse(sections[1].trim());
  assert.equal(returned.returned.self, "[Circular]");
  assert.equal(returned.count, "9n");
});

test("large data output has a bounded preview and a complete recoverable log", async t => {
  const medium = "READ_BEGIN:" + "0123456789".repeat(3000) + ":READ_END";
  for (const header of ["", '// @options: {"timeout_ms":10000}\n']) {
    const result = await builtin.execute("medium-data", { code: `${header}text(${JSON.stringify(medium)});` }, undefined, undefined, undefined as never);
    assert.equal(result.isError, undefined);
    const spill = (result.details as { fullOutputPath?: string }).fullOutputPath;
    if (spill) t.after(() => rm(spill, { force: true }));
    assert.equal(spill, undefined);
    assert.equal((result.content[1] as { text: string }).text, medium);
  }
  const value = "BEGIN:" + "0123456789".repeat(6000) + ":END";
  const result = await builtin.execute("large-data", { code: `text(${JSON.stringify(value)});` }, undefined, undefined, undefined as never);
  assert.equal(result.isError, undefined);
  const path = (result.details as { fullOutputPath?: string }).fullOutputPath;
  assert.ok(path);
  t.after(() => rm(path, { force: true }));
  const preview = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  assert.ok(preview.length < 42000, `Preview unexpectedly large: ${preview.length}`);
  assert.match(preview, /BEGIN:/);
  assert.match(preview, /:END/);
  assert.equal((await readFile(path, "utf8")).trim(), value);
  const lines = Array.from({ length: 500 }, (_, i) => `ROW_${i}_` + "中".repeat(20)).join("\n");
  const paged = await builtin.execute("large-lines", { code: `// @options: {"max_output_tokens":300}\ntext(${JSON.stringify(lines)});` }, undefined, undefined, undefined as never);
  const log = (paged.details as { fullOutputPath: string }).fullOutputPath;
  t.after(() => rm(log, { force: true }));
  const body = (paged.content[1] as { text: string }).text;
  assert.match(body, /\n\.\.\. output truncated \.\.\.\n/);
  for (const line of body.split("\n").filter(line => line.startsWith("ROW_"))) assert.match(line, /^ROW_\d+_中{20}$/);
  assert.equal((await readFile(log, "utf8")).trim(), lines);
});

test("codemode documents its actual runtime and preserves explicit JSON serialization", async () => {
  assert.match(builtin.description, /QuickJS/);
  assert.match(builtin.description, /Node APIs.*run Node in the terminal/);
  assert.match(builtin.description, /Models API reference/);
  const result = await builtin.execute("runtime-contract", { code: `
    text({ url: typeof URL, buffer: typeof Buffer, process: typeof process,
      serializedError: JSON.stringify(new Error("explicit JSON")) });
  ` }, undefined, undefined, undefined as never);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse((result.content[1] as { text: string }).text), {
    url: "undefined", buffer: "undefined", process: "undefined", serializedError: "{}",
  });
});

test("options, strict directives, shadowing, returned Errors and final comments survive the scope adapter", async () => {
  const output = await builtin.execute("scope", { code: `// @options: {"max_output_tokens": 1000}
"use strict";
let strict = false;
try { undeclared = true; } catch (error) { strict = error instanceof ReferenceError; }
const text = "local";
return { strict, text, frozen: Object.isFrozen(Error.prototype), error: new RangeError("returned") }; // final comment` }, undefined, undefined, undefined as never);
  assert.equal(output.isError, undefined, JSON.stringify(output.content));
  assert.deepEqual(JSON.parse((output.content[1] as { text: string }).text), {
    strict: true, text: "local", frozen: true, error: { name: "RangeError", message: "returned" },
  });
  for (const code of ["", "// @options: {}", "// @options: {}\n ", "text(1);\n// @options: {}"]) {
    await assert.rejects(builtin.execute("invalid", { code }, undefined, undefined, undefined as never), /source|first line|followed by/i);
  }
});

test("script errors stay red-flagged and plain text stays plain", () => {
  const view = render([{ type: "text", text: "partial" }, { type: "text", text: "Script error:\nError: nope" }], [], true, true);
  const text = plain(view);
  assert.match(text, /partial\nScript error:\nError: nope/);
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l0AAAAASUVORK5CYII=";
const imageBlock = { type: "image", data: png, mimeType: "image/png" };

test("image accepts blocks, tool envelopes, data URIs and raw base64 through the native decoder", async () => {
  const envelope = { content: [{ type: "text", text: '{"screenshot_id":"shot_1"}' }, imageBlock], details: { screenshot_id: "shot_1" } };
  for (const value of [imageBlock, envelope, `data:image/png;base64,${png}`, png]) {
    const result = await builtin.execute("image", { code: `image(${JSON.stringify(value)});` }, undefined, undefined, undefined as never);
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual(result.content.filter(c => c.type === "image"), [imageBlock]);
  }
  for (const value of ["not an image", png.slice(0, -1), "https://example.com/image.png", { content: [{ type: "text", text: "no image" }], details: {} }]) {
    const result = await builtin.execute("invalid-image", { code: `image(${JSON.stringify(value)});` }, undefined, undefined, undefined as never);
    assert.equal(result.isError, true);
    assert.equal(result.content.filter(c => c.type === "image").length, 0);
  }
});

test("image-shaped data in text, console and return stays data, including invalid image bytes", async () => {
  for (const emit of ["text(value)", "console.log(value)", "return value"]) {
    const result = await builtin.execute("typed-image", { code: `
      const img = { type: "image", mimeType: "image/png", data: "ordinary text, not encoded pixels" };
      const value = { label: "screenshot", images: [img, img] };
      ${emit};
    ` }, undefined, undefined, undefined as never);
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual(result.content.filter(c => c.type === "image"), []);
    const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    assert.ok(text.includes("screenshot") && text.includes("ordinary text"), text);
  }
  const explicit = await builtin.execute("encoded-data", { code: `
    const img = ${JSON.stringify(imageBlock)};
    text(img);
    text(img.data);
    text(JSON.stringify(img));
    text({ type: "image", data: "ordinary text" });
  ` }, undefined, undefined, undefined as never);
  assert.equal(explicit.isError, undefined);
  assert.equal(explicit.content.filter(c => c.type === "image").length, 0);
  assert.ok(explicit.content.some(c => c.type === "text" && c.text.includes(png)));
  assert.ok(explicit.content.some(c => c.type === "text" && c.text.includes("ordinary text")));
});

test("script diagnostics map syntax and runtime failures to the user's source, including options", async () => {
  for (const [code, row, fragment] of [
    ["const = 1;", 1, "const = 1;"],
    ["const value = null;\nvalue.run();", 2, "value.run();"],
    ['new URL("https://example.com");', 1, 'new URL("https://example.com")'],
    ['// @options: {"max_output_tokens":1000}\nconst value = null;\nvalue.run();', 3, "value.run();"],
    ['text("before failure");\nthrow new Error("broken"); // final comment', 2, 'throw new Error("broken")'],
  ] as const) {
    const result = await builtin.execute("source-error", { code }, undefined, undefined, undefined as never);
    assert.equal(result.isError, true);
    const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    assert.match(text, new RegExp(`Source \\(${row}(?::\\d+)?\\):`));
    assert.ok(text.includes(`> ${row} | ${fragment}`), text);
    assert.match(text, /No tool calls were made/);
    assert.doesNotMatch(text, /Store changes from this script/);
    if (code.startsWith('text("before')) assert.ok(text.includes("before failure"));
  }
  await assert.rejects(builtin.execute("misplaced-options", { code: 'text("ok");\n// @options: {"timeout_ms":5000}\nreturn 1;' }, undefined, undefined, undefined as never), /found one on line 2/);
});

test("argument errors keep the failed field and missing-tool hints identify a usable route", () => {
  const tools = [
    { name: "codemode", exposure: "model-only" },
    { name: "exec_command", exposure: "direct" },
    { name: "web_fetch", exposure: "deferred" },
    { name: "secret_tool", exposure: "hidden" },
  ] as Parameters<typeof toolErrorHint>[1];
  const active = ["codemode", "tool_search", "exec_command"];
  const error = 'Validation failed for tool "fixture":\n  - limit: expected <= 5';
  assert.equal(compactArgumentError(error + "\n\nReceived arguments:\n" + "unused".repeat(5000), "fixture"), error);
  assert.match(toolErrorHint("Tool codemod not found", tools, active)!, /call codemode directly/);
  assert.match(toolErrorHint("Tool web_fetch not found", tools, active)!, /load with tool_search/);
  for (const selection of [active, [...active, "web_fetch"]]) {
    assert.match(toolErrorHint("Tool web_fetch not found", tools, selection, true)!, /use codemode and describeTool\("web_fetch"\)/);
  }
  assert.match(toolErrorHint("Tool exec_command not found", tools, active, true)!, /use codemode/);
  assert.equal(toolErrorHint("Tool secret_too not found", tools, active), undefined);
  assert.equal(toolErrorHint("TypeError: not a function", tools, active), undefined);
});

test("script failures preserve file effects and prior store values; missing lookups fail explicitly", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-prime-script-state-"));
  t.after(() => {
    assert.ok(directory.startsWith(join(tmpdir(), "pi-prime-script-state-")));
    return rm(directory, { recursive: true, force: true });
  });
  const settingsManager = SettingsManager.inMemory({ extensions: ["-builtin:codemode"] });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager, extensionFactories: [codemode],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const model = { provider: "test", api: "openai-completions" as const, id: "gpt-offline-test", name: "Offline test",
    baseUrl: "http://127.0.0.1", reasoning: false, input: ["text" as const], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), model, tools: ["codemode", "read", "write"] });
  t.after(() => session.dispose());
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: error => errors.push(error) });
  session.agent.getApiKey = () => "offline-test";
  let runId = 0;
  const run = async (code: string) => {
    const id = `state-test-${++runId}`;
    let first = true;
    session.agent.streamFunction = () => {
      const call = first;
      first = false;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call ? [{ type: "toolCall", id, name: "codemode", arguments: { code } }] : [{ type: "text", text: "done" }],
        stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
      return stream;
    };
    await session.agent.prompt("Exercise script state offline.");
    const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
    assert.ok(result?.role === "toolResult");
    return result;
  };
  const text = (result: Pick<AgentToolResult<unknown>, "content">) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  assert.ok(!(await run('store("checkpoint", "before");')).isError);
  const path = join(directory, "effect.txt");
  const failed = await run(`await tools.write({path:${JSON.stringify(path)},content:"written"});
store("checkpoint", "after"); store("path", ${JSON.stringify(path)});
throw new Error("intentional failure");`);
  assert.equal(failed.isError, true);
  assert.match(text(failed), /intentional failure/);
  assert.match(text(failed), /Store changes from this script were not saved/);
  assert.equal(await readFile(path, "utf8"), "written");
  assert.match(text(failed), /file action completed/);
  assert.ok(text(failed).includes(JSON.stringify(path)));
  const next = await run('text({checkpoint:load("checkpoint"), pathType:typeof load("path")});');
  assert.ok(!next.isError, text(next));
  assert.match(text(next), /"checkpoint":"before","pathType":"undefined"/);

  const missing = await run('const description = await describeTool("nonexistent_probe_tool"); text({description});');
  assert.equal(missing.isError, true);
  assert.match(text(missing), /Tool "nonexistent_probe_tool" is not available.*Use searchTools/);
  const caught = await run(`try { await describeTool("nonexistent_probe_tool"); } catch (error) { text(error.message); }
text(typeof await describeTool("read")); store("checkpoint", "recovered");`);
  assert.ok(!caught.isError, text(caught));
  assert.match(text(caught), /string/);
  assert.doesNotMatch(text(caught), /Store changes from this script were not saved/);
  assert.match(text(await run('text(load("checkpoint"));')), /recovered/);
  const handled = await run('text(await Promise.allSettled([tools.read({})]));');
  assert.match(text(handled), /path: missing/);
  assert.doesNotMatch(text(handled), /Nested tool outcomes/);
  const silent = await run('await Promise.allSettled([tools.read({})]);');
  assert.doesNotMatch(text(silent), /Nested tool outcomes|path: missing/);
  assert.doesNotMatch(text(silent), /Received arguments/);
  const caughtRead = await run('try { await tools.read({}); } catch {} return "handled";');
  assert.ok(!caughtRead.isError);
  assert.doesNotMatch(text(caughtRead), /Nested tool outcomes|path: missing/);
  const uncaught = await run('await tools.read({});');
  assert.equal(uncaught.isError, true);
  assert.equal(text(uncaught).split("path: missing").length - 1, 1);
  assert.match(text(uncaught), /Nested tool outcomes[\s\S]*read \[[^\]]+\] \(error\)/);
  assert.deepEqual(errors, []);
});

test("calls a failed script stopped awaiting report the state they settle on", { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-prime-stopped-calls-"));
  t.after(() => {
    assert.ok(directory.startsWith(join(tmpdir(), "pi-prime-stopped-calls-")));
    return rm(directory, { recursive: true, force: true });
  });
  const aborted = (signal?: AbortSignal) => new Promise<void>(resolve => signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true }));
  let finishLate!: () => void;
  const late = new Promise<void>(resolve => { finishLate = resolve; });
  const tools = (pi: ExtensionAPI) => {
    // Mirrors TerminalRuntime: a launch in progress finishes after the abort and then reports its
    // session; a queued launch rejects without starting.
    pi.registerTool({
      name: "exec_command", label: "exec_command", description: "Fake terminal.",
      parameters: Type.Object({ cmd: Type.String() }),
      async execute(_id, { cmd }, signal) {
        await aborted(signal);
        if (cmd === "queued") throw new Error("Cancelled before launch; the command did not start.");
        await new Promise(resolve => setTimeout(resolve, 100));
        const output = { wall_time_seconds: 0.1, output: "", session_id: 4242, cancelled: true, original_token_count: 0 };
        return { content: [{ type: "text", text: "Wait cancelled; session available · session_id=4242" }], details: output, structuredContent: output };
      },
    });
    // One write finishes during the grace period. The other settles after the parent returns.
    pi.registerTool({
      name: "slow_write", label: "slow_write", description: "Fake slow write.",
      parameters: Type.Object({ hang: Type.Boolean() }),
      async execute(_id, { hang }, signal) {
        if (hang) await late;
        else {
          await aborted(signal);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { content: [{ type: "text", text: "written" }], details: undefined };
      },
    });
  };
  const settingsManager = SettingsManager.inMemory({ extensions: ["-builtin:codemode"] });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager, extensionFactories: [codemode, tools],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const model = { provider: "test", api: "openai-completions" as const, id: "gpt-offline-test", name: "Offline test",
    baseUrl: "http://127.0.0.1", reasoning: false, input: ["text" as const], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const sessionManager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager,
    resourceLoader: loader, sessionManager, model, tools: ["codemode", "write", "exec_command", "slow_write"] });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  session.agent.state.messages.push({
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const script = session.agent.state.tools.find(tool => tool.name === "codemode")!;
  const started = performance.now();
  const failed = await script.execute("stopped-calls", { code: `tools.exec_command({cmd:"launch"});
tools.exec_command({cmd:"queued"});
tools.slow_write({hang:true});
tools.slow_write({hang:false});
await tools.write({path:${JSON.stringify(join(directory, "effect.txt"))},content:"written"});
throw new Error("sibling failed");` });
  assert.ok(performance.now() - started < 5000, "a nested call that ignores the abort must not hold the script result");
  const report = failed.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(report, /exec_command \[[^\]]+\] \(wait stopped\)/, report);
  assert.match(report, /slow_write \[[^\]]+\] \(outcome unknown\)/, report);
  assert.match(report, /slow_write \[[^\]]+\] \(ok\)/, report);
  assert.doesNotMatch(report, /Tool calls made before the failure/);
  assert.match(report, /wait stopped; process may still be running\. .*write_stdin\(\{session_id:4242\}\)/, report);
  assert.match(report, /the command did not start/, report);
  const finished = await script.execute("successful-unawaited", { code: `tools.exec_command({cmd:"queued"});
tools.slow_write({hang:false});
return "done";` });
  assert.ok(!finished.isError);
  const lateReport = finished.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(lateReport, /exec_command \[[^\]]+\] \(error\): .*did not start/);
  assert.match(lateReport, /slow_write \[[^\]]+\] \(ok\): written/);
  const customEntries = () => sessionManager.getEntries().filter(entry => entry.type === "custom");
  const before = customEntries();
  finishLate();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(customEntries(), before);
});

test("validation and unknown-tool hints reach the next model turn and persisted session", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-prime-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory({ extensions: ["-builtin:codemode"] });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager, extensionFactories: [codemode],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const model = { provider: "test", api: "openai-completions" as const, id: "gpt-offline-test", name: "Offline test",
    baseUrl: "http://127.0.0.1", reasoning: false, input: ["text" as const], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const sessionManager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager,
    resourceLoader: loader, sessionManager, model, tools: ["codemode"] });
  t.after(() => session.dispose());
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: error => errors.push(error) });
  let calls = 0;
  session.agent.getApiKey = () => "offline-test";
  session.agent.streamFunction = (_model, context) => {
    calls++;
    const first = calls === 1;
    if (!first) {
      const results = context.messages.filter(message => message.role === "toolResult");
      assert.equal(results.length, 2);
      assert.ok(results.every(result => result.isError));
      assert.match(JSON.stringify(results[0].content), /Validation failed.*code/);
      assert.doesNotMatch(JSON.stringify(results[0].content), /Received arguments/);
      assert.match(JSON.stringify(results[1].content), /Tool codemod not found.*call codemode directly/);
    }
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: first ? [
        { type: "toolCall", id: "bad-args", name: "codemode", arguments: { script: "text(1)" } },
        { type: "toolCall", id: "bad-name", name: "codemod", arguments: { code: "text(1)" } },
      ] : [{ type: "text", text: "done" }],
      stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
    return stream;
  };
  await session.agent.prompt("Exercise invalid tool calls offline.");
  assert.equal(calls, 2);
  assert.deepEqual(errors, []);
  const persisted = sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult");
  assert.equal(persisted.length, 2);
  assert.ok(persisted.some(entry => JSON.stringify(entry).includes("call codemode directly")));
  assert.ok(persisted.every(entry => !JSON.stringify(entry).includes("Received arguments")));
});

test("failed scripts preserve unprinted effects and model calls before the full output pointer", async t => {
  const definitions = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Function[]>();
  const api = {
    on(name: string, fn: Function) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name)!.push(fn); return () => {}; },
    registerTool(tool: ToolDefinition) { definitions.set(tool.name, tool); },
    registerToolRenderer() {}, registerCommand() {},
    getSettings: () => ({}),
    getAllTools: () => [...definitions.values()].map(tool => ({ ...tool, exposure: tool.exposure ?? "direct" })),
    getActiveTools: () => ["codemode", "read", "exec_command", "external_action"],
    setActiveTools() {},
  } as unknown as ExtensionAPI;
  api.registerTool({
    name: "read", label: "read", description: "Read text.", parameters: Type.Object({ path: Type.String() }),
    async execute() { return { content: [{ type: "text", text: "file-body" }], details: undefined }; },
  });
  api.registerTool({
    name: "exec_command", label: "exec_command", description: "Run shell.", parameters: Type.Object({ cmd: Type.String() }),
    outputSchema: Type.Object({ wall_time_seconds: Type.Number(), output: Type.String(), exit_code: Type.Number(), original_token_count: Type.Integer() }),
    async execute() {
      const out = { wall_time_seconds: 0.1, output: "PRINTED_ONCE_MARKER\n", exit_code: 0, original_token_count: 5 };
      return { content: [{ type: "text", text: "Exit 0\nPRINTED_ONCE_MARKER\n" }], details: out, structuredContent: out };
    },
  });
  api.registerTool({
    name: "external_action", label: "external_action", description: "GUI act.", parameters: Type.Object({}),
    outputSchema: Type.Object({ content: Type.Array(Type.Any()), details: Type.Record(Type.String(), Type.Unknown()) }),
    async execute() {
      const details = { executed: 2, status: "applied", screenshot_id: "shot_after_click" };
      const content = [{ type: "text" as const, text: "Applied two actions (shot_after_click)." }];
      return { content, details, structuredContent: { content, details } };
    },
  });
  codemode(api);
  const emit = async (name: string, event: unknown) => { for (const fn of handlers.get(name) ?? []) await fn(event); };
  const ctx = {
    tools: ["read", "exec_command", "external_action"].map(name => definitions.get(name)!),
    modelRegistry: { getModelOfType: () => ({ provider: "offline", id: "test" }), classify: async () => ({ stopReason: "stop" }) },
    sessionManager: { getBranch: () => [], getSessionId: () => "s1" },
    async executeTool(name: string, args: unknown) {
      const callId = `id_${name}`;
      await emit("tool_execution_start", { parentToolCallId: "parent", toolCallId: callId, toolName: name, args });
      const result = await definitions.get(name)!.execute(callId, args as never, undefined, undefined, {} as never);
      await emit("tool_execution_end", { parentToolCallId: "parent", toolCallId: callId, toolName: name, result, isError: false });
      return { toolCall: { id: callId, name }, result, isError: false };
    },
  };
  const failed = await definitions.get("codemode")!.execute("parent", {
    code: `// @options: {"max_output_tokens":800}
      text("row\\n".repeat(2000));
      await tools.read({ path: "a.ts" });
      const r = await tools.exec_command({ cmd: "echo" });
      text(r);
      await tools.external_action({});
      await models.classify({provider:"offline", id:"test"}, {state:{}, questions:{q:{type:"bool", instructions:"Inspect", criteria:{true:"yes", false:"no"}}}});
      throw new Error("boom after side effects");
    `,
  }, undefined, undefined, ctx as never);
  assert.equal(failed.isError, true);
  const { fullOutputPath } = failed.details as { fullOutputPath: string };
  assert.ok(fullOutputPath);
  t.after(() => rm(fullOutputPath, { force: true }));
  const full = failed.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  assert.equal(full.split("PRINTED_ONCE_MARKER").length - 1, 1, full);
  assert.doesNotMatch(full, /- read \[id_read\]/);
  assert.match(full, /- external_action \[id_external_action\] \(ok\): Applied two actions \(shot_after_click\)/);
  assert.match(full, /Tool calls made before the failure [^\n]*: models\.classify \(ok\)\n/);
  assert.match(full, /Script error:[\s\S]*Source \([^)]+\):[\s\S]*Nested tool outcomes[\s\S]*\[Full output: [^\n]+\]$/);
  const rejected = await definitions.get("codemode")!.execute("host", { code: 'await tools.read({path:"a"});' }, undefined, undefined, {
    ...ctx, executeTool: async () => { throw new Error("host disconnected"); },
  } as never);
  const diagnostic = rejected.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  assert.match(diagnostic, /host disconnected/);
  assert.match(diagnostic, /- read \[1\] \(error\)/);
});

test("artifact reaper respects fresh child logs inside long-lived directories", async t => {
  const root = join(tmpdir(), "pi-prime-artifacts");
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, "x");
  const staleDir = join(root, `codemode-999999991-${suffix}`);
  const activeLogDir = join(root, `codemode-999999992-${suffix}`);
  await mkdir(staleDir, { recursive: true });
  await mkdir(activeLogDir, { recursive: true });
  t.after(async () => {
    await rm(staleDir, { recursive: true, force: true });
    await rm(activeLogDir, { recursive: true, force: true });
  });
  const baseNow = Date.now();
  const expired = new Date(baseNow - 15 * 24 * 60 * 60_000);
  await writeFile(join(staleDir, "old.txt"), "expired");
  await utimes(join(staleDir, "old.txt"), expired, expired);
  await utimes(staleDir, expired, expired);
  // Simulate a 15-day-old directory whose log file was appended to moments before an abrupt crash.
  await writeFile(join(activeLogDir, "recent.log"), "keep me");
  await utimes(activeLogDir, expired, expired);

  t.mock.method(Date, "now", () => baseNow + 2 * 60 * 60_000);
  const created = artifactDirectory("codemode");
  t.after(() => rm(created, { recursive: true, force: true }));
  for (let i = 0; i < 50 && existsSync(staleDir); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(staleDir), false, "fully expired artifact directory should be reaped");
  assert.equal(existsSync(join(activeLogDir, "recent.log")), true, "directory with a recent log file must survive");
});
