import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolSearchExtension, DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ToolDefinition, type ToolInfo } from "@earendil-works/pi-coding-agent";
import toolSearch from "../src/tool-search.ts";
async function rankTools(query: string, tools: ToolInfo[]) {
	const { search } = setup(tools.map(tool => ({ ...tool, exposure: "deferred" })));
	return ((await search(query)).details as { loaded: string[] }).loaded;
}
import codemode from "../src/codemode.ts";

test("explicit replacement loads one tool_search without built-in collision diagnostics, including on reload", async t => {
	const directory = await mkdtemp(join(tmpdir(), "pi-prime-tool-search-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager: SettingsManager.inMemory({ extensions: ["-builtin:tool-search"] }),
		extensionFactories: [
			toolSearch,
			{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
		],
	});
	for (let i = 0; i < 2; i++) {
		await loader.reload();
		const { extensions, errors, warnings } = loader.getExtensions();
		assert.deepEqual(errors, []);
		assert.deepEqual(warnings ?? [], []);
		assert.equal(extensions.length, 1);
		assert.deepEqual([...extensions[0].tools.keys()], ["tool_search"]);
	}
});

function setup(available?: ToolInfo[], initialActive = ["read", "tool_search"]) {
	const tools = available ?? [
		{ name: "cu_windows", description: "List main application windows, their processes and titles.", exposure: "deferred" },
		{ name: "cu_view", description: "Select a task window and capture it.", exposure: "deferred" },
		{ name: "cu_state", description: "cu_windows cu_view screenshot crop region inspection.", exposure: "deferred" },
		{ name: "hidden_reset", description: "reset", exposure: "hidden" },
		{ name: "device_reset", description: "Reset the test device.", exposure: "deferred" },
	].map(t => ({ ...t, parameters: {} })) as ToolInfo[];
	let active = initialActive;
	let registered!: ToolDefinition;
	toolSearch({
		on: () => () => {},
		registerTool: (tool: ToolDefinition) => { registered = tool; },
		getAllTools: () => tools,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	} as unknown as ExtensionAPI);
	return {
		active: () => active,
		search: (query: string, limit?: number, model?: { id: string }) => registered.execute("search", { query, limit }, undefined, undefined, { model, tools } as never),
	};
}

test("direct discovery and codemode rank held-out capabilities identically", async () => {
  const tools = [
    { name: "pdf_convert", description: "Convert files. Preserve ICC color profiles while exporting PDF documents." },
    { name: "mail_archive", description: "Archive messages. Retain conversation labels and attachments." },
    { name: "db_snapshot", description: "Create a database snapshot with schema and rows." },
    { name: "session_recall", description: "Find historical conversation text." },
  ].map(tool => ({ ...tool, exposure: "deferred", parameters: { type: "object", properties: {} } })) as unknown as ToolInfo[];
  const direct = setup(tools);
  let script!: ToolDefinition;
  codemode({ on: () => () => {}, registerTool: (tool: ToolDefinition) => { script = tool; },
    registerToolRenderer: () => {}, getAllTools: () => tools, getActiveTools: () => ["codemode"],
  } as unknown as ExtensionAPI);
  const ctx = { tools, sessionManager: { getBranch: () => [] } };
  for (const query of ["ICC color profile", "attachments labels", "会话 历史", "db_snapshot mail_archive"]) {
    const expected = (await direct.search(query, 8)).details as { loaded: string[] };
    const result = await script.execute("parity", { code: `text((await searchTools(${JSON.stringify(query)})).map(t => t.name));` }, undefined, undefined, ctx as never);
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const actual = JSON.parse((result.content[1] as { text: string }).text);
    assert.deepEqual(actual, expected.loaded, query);
    assert.ok(actual.length, query);
  }
});

test("capability queries containing tool names keep all ranked candidates in both entry points", async () => {
  for (const exposure of ["direct", "deferred"] as const) {
    const tools = [
      { name: "read", description: "Read plain text files.", exposure },
      { name: "pdf_reader", description: "Read PDF files, including scanned document pages.", exposure: "deferred" },
      { name: "mail_export", description: "Export mail to an archive.", exposure: "deferred" },
    ].map(tool => ({ ...tool, parameters: { type: "object", properties: {} } })) as unknown as ToolInfo[];
    const direct = setup(tools, ["tool_search", "read"]);
    let script!: ToolDefinition;
    codemode({ on: () => () => {}, registerTool: (tool: ToolDefinition) => { script = tool; },
      registerToolRenderer() {}, getAllTools: () => tools, getActiveTools: () => ["codemode", "read"],
    } as unknown as ExtensionAPI);
    const ctx = { tools, sessionManager: { getBranch: () => [] } };
    for (const query of ["read PDF files", "pdf_reader scanned pages", "read scanned-pages", "pdf_reader for pdf_archive migration", "read and summarize PDF files"]) {
      const found = await direct.search(query);
      const ranked = await rankTools(query, tools);
      assert.ok(ranked.includes("pdf_reader"), query);
      assert.deepEqual((found.details as { loaded: string[] }).loaded, ranked.filter(name => tools.find(tool => tool.name === name)?.exposure === "deferred"), query);
      const result = await script.execute("mixed-query", { code: "text((await searchTools(" + JSON.stringify(query) + ")).map(t => t.name));" }, undefined, undefined, ctx as never);
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.deepEqual(JSON.parse((result.content[1] as { text: string }).text), ranked, query);
    }
    const exact = await script.execute("exact-query", { code: 'text((await searchTools("mail_export pdf_reader")).map(t => t.name));' }, undefined, undefined, ctx as never);
    assert.deepEqual(JSON.parse((exact.content[1] as { text: string }).text), ["mail_export", "pdf_reader"]);
  }
});

test("name lists with missing or hidden names keep exact matches in direct and script discovery", async () => {
  const tools = [
    { name: "web_search", description: "Search the web." },
    { name: "web_fetch", description: "Fetch a page." },
    { name: "cu_act", description: "Operate a window." },
    { name: "mcp__db__run_query", description: "Query a database." },
    { name: "pdf_reader", description: "Read a PDF." },
    { name: "related_tool", description: "web_search web_fetch cu_act mcp__db__run_query nonexistent_tool pdf_archive find powershell" },
    { name: "find", description: "Find files.", exposure: "hidden" },
    { name: "powershell", description: "Run a script.", exposure: "hidden" },
  ].map(tool => ({ exposure: "deferred", ...tool, parameters: { type: "object", properties: {} } })) as unknown as ToolInfo[];
  let script!: ToolDefinition;
  codemode({ on: () => () => {}, registerTool: (tool: ToolDefinition) => { script = tool; },
    registerToolRenderer() {}, getAllTools: () => tools, getActiveTools: () => ["codemode"],
  } as unknown as ExtensionAPI);
  const ctx = { tools: tools.filter(tool => tool.exposure !== "hidden"), sessionManager: { getBranch: () => [] } };
  for (const [query, expected, missing] of [
    ["cu_act, mcp__db__run_query, nonexistent_tool", ["cu_act", "mcp__db__run_query"], "nonexistent_tool"],
    ["web_search and web_fetch", ["web_search", "web_fetch"], undefined],
    ["web_fetch, web_search, web_fetch", ["web_fetch", "web_search"], undefined],
    ["pdf_reader, pdf_archive", ["pdf_reader"], "pdf_archive"],
    ["find powershell web_fetch", ["web_fetch"], "find"],
  ] as const) {
    const direct = setup(tools, ["tool_search"]);
    const result = await direct.search(query);
    assert.deepEqual((result.details as { loaded: string[] }).loaded, expected, query);
    assert.deepEqual(direct.active(), ["tool_search", ...expected], query);
    if (missing) assert.ok(JSON.stringify(result.content).includes(missing));
    const scripted = await script.execute("exact-list", { code: `text((await searchTools(${JSON.stringify(query)})).map(t => t.name));` }, undefined, undefined, ctx as never);
    assert.equal(scripted.isError, undefined, JSON.stringify(scripted.content));
    const text = scripted.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    assert.ok(text.includes(JSON.stringify(expected)), text);
    assert.ok(!text.includes("related_tool"), text);
    if (missing) assert.ok(text.includes(missing), text);
  }
});

test("a ready terminal ranks first without suppressing other relevant candidates", async () => {
	const { search, active } = setup([
		{ name: "terminal_sessions", description: "List terminal sessions started by this Pi session.", exposure: "direct" },
		{ name: "session_recall", description: "Recover text from previous sessions.", exposure: "deferred" },
		{ name: "cu_windows", description: "List main desktop windows.", exposure: "deferred" },
		{ name: "cu_abort", description: "Stop desktop input for this session.", exposure: "deferred" },
		{ name: "hidden_terminal", description: "List terminal sessions.", exposure: "hidden" },
	].map(tool => ({ ...tool, parameters: {} })) as ToolInfo[], ["tool_search", "terminal_sessions"]);
	const terminal = await search("terminal sessions list", 1);
	assert.equal((terminal.content[0] as { text: string }).text, "Already available for direct calls: terminal_sessions.");
	assert.deepEqual(terminal.details, { loaded: [] });
	assert.deepEqual(active(), ["tool_search", "terminal_sessions"]);
	assert.deepEqual((await search("desktop windows", 1)).details, { loaded: ["cu_windows"] });
});

test("exact names share one query-ordered limit across active and deferred tools", async () => {
	const tools = ["read", "edit", "write", "lookup"].map(name => ({
		name, description: name, parameters: {}, exposure: name === "lookup" ? "deferred" : "direct",
	})) as ToolInfo[];
	for (const [id, label] of [["claude-test", "Already available for direct calls"], ["gpt-test", "Available inside codemode"]]) {
		const { search, active } = setup(tools, ["codemode", "read", "edit", "write"]);
		const result = await search("read edit write", 1, { id });
		const text = (result.content[0] as { text: string }).text;
		assert.ok(text.startsWith(label + ": read."));
		assert.doesNotMatch(text, /\bedit\b|\bwrite\b/);
		assert.deepEqual((await search("edit lookup read", 1, { id })).details, { loaded: [] });
		assert.ok(!active().includes("lookup"));
		const mixed = await search("edit lookup read write", 3, { id });
		assert.deepEqual(mixed.details, { loaded: ["lookup"] });
		const lines = (mixed.content[0] as { text: string }).text.split("\n");
		assert.ok(lines[0].startsWith(label + ": edit."));
		assert.match(lines[1], /^- lookup \(available next turn\)/);
		assert.ok(lines[2].startsWith(label + ": read."));
		assert.equal(lines.length, 4);
	}
});

test("explicit CU names beat cross-references, obey query order/limit, and remain discoverable when active", async () => {
	const { search, active } = setup();
	assert.deepEqual((await search("+cu_windows +cu_view", 2)).details, { loaded: ["cu_windows", "cu_view"] });
	assert.deepEqual(active(), ["read", "tool_search", "cu_windows", "cu_view"]);
	assert.deepEqual((await search("cu_windows: cu_view.", 2)).details, { loaded: ["cu_windows", "cu_view"] });
	assert.deepEqual(active(), ["read", "tool_search", "cu_windows", "cu_view"]);
	assert.deepEqual((await search("cu_view, cu_windows cu_view", 1)).details, { loaded: ["cu_view"] });
	const partial = await search("cu_windows, cu_veiw");
	assert.match(JSON.stringify(partial.content), /cu_windows \(already loaded\).*Unmatched names: cu_veiw/);
});

test("full descriptions retain recall while stronger capability matches rank first", async () => {
	const tools = [
		{ name: "session_recall", description: "Find original text evidence in this session's current branch, including before compaction. Search other history with distinctive words. Use role=user for decisions or corrections, toolResult for shell executions.", parameters: { query: { description: "Search keywords" } } },
		{ name: "web_fetch", description: "Fetch a web page by URL.", parameters: {} },
		{ name: "container_restart", description: "Restart a Docker container.", parameters: {} },
	] as unknown as ToolInfo[];
	assert.equal((await rankTools("web search fetch url browse internet", tools))[0], "web_fetch");
	assert.equal((await rankTools("docker container service environment reset restart shell command", tools))[0], "container_restart");
	assert.deepEqual(await rankTools("user corrections", tools), ["session_recall"]);
	assert.deepEqual(await rankTools("history", tools), ["session_recall"]);
});

test("discovery loads relevant capabilities and leaves unavailable searches empty", async () => {
	const { search, active } = setup([
		{ name: "session_recall", description: "Find original text evidence in this session's current branch. Search history of shell executions." },
		{ name: "web_fetch", description: "Fetch a web page by URL." },
		{ name: "parse_HTMLDocument", description: "Parse markup." },
		{ name: "catalog", description: "Manage boxes and repositories." },
		{ name: "中文工具", description: "搜索历史记录。" },
	].map(tool => ({ ...tool, exposure: "deferred", parameters: {} })) as ToolInfo[]);
	assert.deepEqual((await search("web search fetch url browse internet", 1)).details, { loaded: ["web_fetch"] });
	const missing = await search("nonexistent_capability_94812");
	assert.deepEqual(missing.details, { loaded: [] });
	assert.match(JSON.stringify(missing.content), /No matching tools found/);
	assert.ok(!active().includes("session_recall"));
	assert.deepEqual((await search("HTML")).details, { loaded: ["parse_HTMLDocument"] });
	assert.deepEqual((await search("box repository")).details, { loaded: ["catalog"] });
	assert.equal(((await search("历史记录")).details as { loaded: string[] }).loaded[0], "中文工具");
	const history = await search("查找这次会话之前的原文");
	assert.deepEqual(history.details, { loaded: ["session_recall"] });
	assert.match(JSON.stringify((await search("查找这次会话之前的原文")).content), /session_recall \(already loaded\)/);
});

test("secondary description matches and related deferred tools remain searchable", async () => {
	const { search } = setup([
		{ name: "doc_read", description: "Read a document. Supports PDF, EPUB, and DOCX formats.", exposure: "deferred" },
		{ name: "image_settings", description: "Manage image settings. Supports ICC color profiles.", exposure: "deferred" },
		{ name: "theme_color", description: "Change the interface color.", exposure: "deferred" },
		{ name: "terminal_sessions", description: "List terminal sessions started by this Pi session.", exposure: "direct" },
		{ name: "session_export", description: "Export terminal sessions to an archive.", exposure: "deferred" },
	].map(tool => ({ ...tool, parameters: {} })) as ToolInfo[], ["tool_search", "terminal_sessions"]);
	assert.deepEqual((await search("PDF files")).details, { loaded: ["doc_read"] });
	assert.deepEqual((await search("color profiles", 1)).details, { loaded: ["image_settings"] });
	assert.ok(((await search("terminal sessions list")).details as { loaded: string[] }).loaded.includes("session_export"));
});

test("natural-language queries retain Pi's ranker, exposure filtering and validation", async () => {
	const { search, active } = setup();
	assert.deepEqual((await search("crop region", 1)).details, { loaded: ["cu_state"] });
	const hidden = await search("hidden_reset", 1);
	assert.deepEqual(hidden.details, { loaded: [] });
	assert.match(JSON.stringify(hidden.content), /Unavailable through tool_search: hidden_reset/);
	assert.ok(!active().includes("hidden_reset"));
	await assert.rejects(search("cu_windows", 0), /positive integer/);
	await assert.rejects(search(" ", 1), /empty/);
});
