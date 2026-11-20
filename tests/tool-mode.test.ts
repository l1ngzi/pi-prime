import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import codemode from "../src/codemode.ts";
import toolSearch from "../src/tool-search.ts";
import sessionRecall from "../src/session-recall.ts";
import { isGptModel } from "../src/tool-mode.ts";

function deferredFixture(pi: ExtensionAPI): void {
  const empty = async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined });
  pi.registerTool({ name: "doc_search", label: "Doc Search", description: "Search reference documentation.", exposure: "deferred", parameters: Type.Object({}), execute: empty });
  pi.registerTool({ name: "doc_fetch", label: "Doc Fetch", description: "Fetch a reference page by URL.", exposure: "deferred", parameters: Type.Object({}), execute: empty });
}

const model = (id: string, provider = "offline"): Model<"openai-completions"> => ({
  id, provider, api: "openai-completions", name: id, baseUrl: "http://127.0.0.1", reasoning: false,
  input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

test("GPT identity follows the model ID, including provider-qualified IDs", () => {
  for (const id of ["gpt-6.1-sol", "gpt-6.1-terra", "openai/gpt-6-astra", "GPT-4.1"]) assert.equal(isGptModel(model(id)), true);
  for (const id of ["deepseek-flash", "claude-opus", "gemini-pro", "qwen3.8-flash", "my-gpt-proxy"]) assert.equal(isGptModel(model(id, "openai")), false);
  assert.equal(isGptModel(undefined), false);
});

test("native tools with optional codemode and GPT codemode-only survive switches, reload, resume and tree navigation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-prime-tool-mode-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, "fixture.txt");
  await writeFile(fixture, "batch-read-fixture");
  const models = [model("deepseek-flash", "openai"), model("openai/gpt-6.1-sol", "proxy"), model("claude-opus", "openai")];
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  t.mock.method(runtime, "checkAuth", async () => ({ type: "api_key" }));
  t.mock.method(runtime, "hasConfiguredAuth", () => true);
  t.mock.method(runtime, "getModel", (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id));
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["read", "edit", "write", "codemode", "tool_search"], codemode: { mode: "only" },
    extensions: ["-builtin:codemode", "-builtin:tool-search"], compaction: { enabled: false }, cacheWarming: "off",
  });
  let api!: ExtensionAPI;
  let switchAfterTool: typeof models[number] | undefined;
  const extra: ToolDefinition[] = [];
  const errors: unknown[] = [];
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
  t.after(() => { for (const session of sessions) session.dispose(); });
  const create = async (sessionManager: SessionManager, selected?: typeof models[number], tools?: string[], settings = settingsManager) => {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
      extensionFactories: [codemode, toolSearch, deferredFixture, sessionRecall, pi => {
        api = pi;
        for (const tool of extra) pi.registerTool(tool);
        pi.on("tool_result", async () => {
          if (!switchAfterTool) return;
          const selected = switchAfterTool;
          switchAfterTool = undefined;
          await pi.setModel(selected);
        });
      }],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model: selected,
      modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager, tools });
    sessions.push(session);
    await session.bindExtensions({ onError: error => errors.push(error) });
    session.agent.getApiKey = () => "offline-test";
    return session;
  };
  let session = await create(SessionManager.create(directory, join(directory, "sessions")), models[0]);
  let prompts = 0;
  const exercise = async (route = isGptModel(session.model) ? "codemode" : "native") => {
    const marker = `request-${++prompts}`;
    const scripted = route === "codemode";
    let turns = 0;
    session.agent.streamFunction = (current, context) => {
      const gpt = isGptModel(current);
      const declared = getCurrentTools(context.messages);
      const names = declared.map(tool => tool.name);
      assert.ok(names.includes("codemode"), names.join(", "));
      const scriptDescription = declared.find(tool => tool.name === "codemode")!.description;
      assert.match(scriptDescription, /\bimage\s*\(/);
      assert.match(scriptDescription, /\bstore\s*\(/);
      for (const name of ["read", "write", "edit"]) {
        const native = declared.find(tool => tool.name === name);
        assert.equal(!!native, !gpt, names.join(", "));
        assert.equal(new RegExp(`\\b${name}\\s*\\(`).test(scriptDescription), gpt, `codemode declaration for ${name}`);
        if (native) assert.ok(native.description.includes(`tools.${name}`), native.description);
      }
      assert.ok(names.includes("tool_search"));
      assert.doesNotMatch(session.systemPrompt, /session_recall/);
      const first = turns++ === 0;
      const input = { path: join(directory, "marker.txt"), content: marker };
      const message: AssistantMessage = { role: "assistant", api: current.api, provider: current.provider, model: current.id,
        content: first ? [{ type: "toolCall", id: marker, name: scripted ? "codemode" : "write",
          arguments: scripted ? { code: `text(await tools.write(${JSON.stringify(input)}));
text(await Promise.allSettled([tools.read({path: ${JSON.stringify(input.path)}}), tools.read({path: ${JSON.stringify(fixture)}})]));` } : input }] : [{ type: "text", text: "done" }],
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      return stream;
    };
    await session.prompt("Write the next marker using the available tools.");
    assert.equal(turns, 2, JSON.stringify(session.messages.at(-1)));
    assert.equal(await readFile(join(directory, "marker.txt"), "utf8"), marker);
    if (scripted) {
      const result = [...session.messages].reverse().find(message => message.role === "toolResult");
      assert.ok(result?.role === "toolResult" && !result.isError, JSON.stringify(result));
      const output = JSON.stringify(result.content);
      assert.match(output, /batch-read-fixture/);
      assert.ok(output.includes(marker));
      assert.doesNotMatch(output, /rejected/);
    }
    assert.deepEqual(errors, []);
  };
  await exercise();
  const searchTools = (query: string) => session.agent.state.tools.find(tool => tool.name === "tool_search")!
    .execute("verify-tool-route", { query });
  const nativeSearch = await searchTools("read write edit codemode");
  assert.match(JSON.stringify(nativeSearch.content), /Already available for direct calls: read, write, edit, codemode\./);
  assert.deepEqual(nativeSearch.details, { loaded: [] });
  const discovery = session.agent.state.tools.find(tool => tool.name === "codemode")!;
  const found = await discovery.execute("discover-by-script", { code: `
    const names = async (query) => (await searchTools(query)).map(tool => tool.name);
    text(await Promise.all([names("查找这次会话之前的原文"), names("fetch reference page url"), names("doc_fetch doc_search")]));
  ` });
  assert.equal(found.isError, undefined, JSON.stringify(found.content));
  const names = JSON.parse((found.content[1] as { text: string }).text) as string[][];
  assert.deepEqual(names[0], []);
  assert.ok(names[1].includes("doc_fetch"));
  assert.deepEqual(names[2], ["doc_fetch", "doc_search"]);
  const nativeLeaf = session.sessionManager.getLeafId()!;
  await exercise("codemode");
  assert.equal(session.getAllTools().find(tool => tool.name === "codemode")?.exposure, "model-only");
  // Match MCP's late registration/auto-enable behavior without connecting a server.
  extra.push({ name: "mcp__test__lookup", label: "Lookup", description: "Look up a test item.",
    exposure: "deferred", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "found" }], details: undefined }) });
  api.registerTool(extra[0]);
  api.setActiveTools([...api.getActiveTools(), "codemode"]);
  assert.ok(session.getActiveToolNames().includes("codemode"));
  const search = session.agent.state.tools.find(tool => tool.name === "tool_search")!;
  await search.execute("discover", { query: "mcp__test__lookup" });
  assert.ok(session.getActiveToolNames().includes("mcp__test__lookup"));
  await session.setModel(models[1]);
  await exercise();
  const gptSearch = await searchTools("read write edit codemode");
  assert.match(JSON.stringify(gptSearch.content), /Available inside codemode: read, write, edit\./);
  assert.match(JSON.stringify(gptSearch.content), /Already available for direct calls: codemode\./);
  assert.deepEqual(gptSearch.details, { loaded: [] });
  const gptLeaf = session.sessionManager.getLeafId()!;
  assert.ok(session.getActiveToolNames().includes("mcp__test__lookup"));
  await session.reload();
  await exercise();
  await session.setModel(models[2]);
  await exercise();
  await exercise("codemode");
  await session.reload();
  await exercise();
  await exercise("codemode");
  const path = session.sessionFile!;
  session.dispose();
  session = await create(SessionManager.open(path));
  assert.equal(session.model?.id, models[2].id);
  await exercise();
  await exercise("codemode");
  await session.setModel(models[1]);
  await exercise();
  await session.navigateTree(nativeLeaf, { summarize: false });
  // Tree navigation keeps the user's current model; its route overrides the old loadout.
  assert.equal(session.model?.id, models[1].id);
  await exercise();
  await session.setModel(models[0]);
  await session.navigateTree(gptLeaf, { summarize: false });
  assert.equal(session.model?.id, models[0].id);
  await exercise();
  await exercise("codemode");
  switchAfterTool = models[1];
  await exercise();
  assert.equal(session.model?.id, models[1].id);
  switchAfterTool = models[0];
  await exercise();
  assert.equal(session.model?.id, models[0].id);
  const restricted = await create(SessionManager.inMemory(directory), models[1], ["read"]);
  assert.deepEqual(restricted.getActiveToolNames(), ["read"]);
  assert.ok(!restricted.getAllTools().some(tool => tool.name === "codemode" || tool.name === "write"));
  await restricted.setModel(models[0]);
  assert.deepEqual(restricted.getActiveToolNames(), ["read"]);
  const deselected = await create(SessionManager.inMemory(directory), models[1], ["-codemode", "-tool_search"]);
  for (const current of models) {
    await deselected.setModel(current);
    assert.ok(!deselected.getActiveToolNames().includes("codemode"));
    assert.ok(!deselected.getActiveToolNames().includes("tool_search"));
  }
  await deselected.reload();
  assert.ok(!deselected.getActiveToolNames().some(name => name === "codemode" || name === "tool_search"));
  const exclusions = SettingsManager.inMemory({ defaultTools: ["-codemode", "-tool_search"] });
  const optedIn = await create(SessionManager.inMemory(directory), models[1], ["+tool_search"], exclusions);
  assert.ok(!optedIn.getActiveToolNames().includes("codemode"));
  assert.ok(optedIn.getActiveToolNames().includes("tool_search"));
  const noDeferred = await create(SessionManager.inMemory(directory), models[1], ["read", "codemode", "tool_search"]);
  assert.ok(!noDeferred.getCallableToolNames().includes("doc_search"));
  noDeferred.agent.streamFunction = (current, context) => {
    assert.ok(!getCurrentTools(context.messages).some(tool => tool.name === "tool_search"));
    assert.doesNotMatch(noDeferred.systemPrompt, /\b(?:doc_search|doc_fetch|session_recall)\b/);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: {
      role: "assistant", api: current.api, provider: current.provider, model: current.id,
      content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } });
    return stream;
  };
  await noDeferred.prompt("Check the available tools.");
  assert.deepEqual(errors, []);
});

test("recall activates after successful compaction and follows the current branch across model switches, reload and resume", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-prime-recall-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = [model("deepseek-flash"), model("gpt-6.1-sol")];
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  t.mock.method(runtime, "checkAuth", async () => ({ type: "api_key" }));
  t.mock.method(runtime, "hasConfiguredAuth", () => true);
  t.mock.method(runtime, "getModel", (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id));
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["codemode", "tool_search"], extensions: ["-builtin:codemode", "-builtin:tool-search"],
    compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 20 }, cacheWarming: "off",
  });
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
  const errors: unknown[] = [];
  t.after(() => { for (const session of sessions) session.dispose(); });
  let cancelCompaction = false;
  const create = async (sessionManager: SessionManager) => {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
      extensionFactories: [sessionRecall, codemode, toolSearch, pi => {
        pi.on("session_before_compact", event => cancelCompaction ? { cancel: true } : { compaction: {
          summary: "Earlier decisions are available through session_recall.",
          firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
        } });
      }],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model: models[0],
      modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager });
    sessions.push(session);
    await session.bindExtensions({ onError: error => errors.push(error) });
    session.agent.getApiKey = () => "offline-test";
    return session;
  };
  let session = await create(SessionManager.create(directory, join(directory, "sessions")));
  const check = async (enabled: boolean) => {
    assert.equal(session.getActiveToolNames().includes("session_recall"), enabled);
    assert.equal(session.getCallableToolNames().includes("session_recall"), enabled);
    session.agent.streamFunction = (current, context) => {
      const tools = getCurrentTools(context.messages);
      assert.equal(tools.some(tool => tool.name === "session_recall"), enabled && !isGptModel(current));
      const script = tools.find(tool => tool.name === "codemode")!;
      assert.equal(script.description.includes("session_recall"), enabled);
      assert.equal(session.systemPrompt.includes("session_recall"), enabled);
      assert.doesNotMatch(session.systemPrompt, /tool_search.*session_recall/);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: {
        role: "assistant", api: current.api, provider: current.provider, model: current.id,
        content: [{ type: "text", text: "checked" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      return stream;
    };
    await session.prompt("Check the tools. Keep the earlier decision: preserve UTF-8 output.");
  };
  await check(false);
  await check(false);
  const beforeCompaction = session.sessionManager.getLeafId()!;
  const script = session.agent.state.tools.find(tool => tool.name === "codemode")!;
  const lookup = await script.execute("before-compaction-discovery", { code: 'text((await searchTools("session_recall")).map(tool => tool.name));' });
  assert.equal(lookup.isError, undefined, JSON.stringify(lookup.content));
  assert.match((lookup.content[1] as { text: string }).text, /^\[\](?:\n|$)/);
  cancelCompaction = true;
  await assert.rejects(session.compact(), /cancelled/i);
  await check(false);
  cancelCompaction = false;
  await session.compact();
  await check(true);
  const recalled = await session.agent.state.tools.find(tool => tool.name === "session_recall")!
    .execute("after-compaction-recall", { query: "UTF-8", role: "user" });
  assert.match(JSON.stringify(recalled.content), /preserve UTF-8 output/);
  await session.setModel(models[1]);
  await check(true);
  const scripted = await session.agent.state.tools.find(tool => tool.name === "codemode")!
    .execute("after-compaction-script-recall", { code: 'text(await tools.session_recall({query:"UTF-8",role:"user"}));' });
  assert.equal(scripted.isError, undefined, JSON.stringify(scripted.content));
  assert.match(JSON.stringify(scripted.content), /preserve UTF-8 output/);
  await session.reload();
  await check(true);
  const compactedLeaf = session.sessionManager.getLeafId()!;
  const path = session.sessionFile!;
  session.dispose();
  session = await create(SessionManager.open(path));
  await check(true);
  await session.navigateTree(beforeCompaction, { summarize: false });
  await check(false);
  await session.navigateTree(compactedLeaf, { summarize: false });
  await check(true);
  session.dispose();
  session = await create(SessionManager.create(directory, join(directory, "sessions")));
  await check(false);
  assert.deepEqual(errors, []);
});
