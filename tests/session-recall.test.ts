import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import sessionRecall from "../src/session-recall.ts";

const textOf = (result: { content: { type: string; text?: string }[] }) =>
	result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");

function setupRecall() {
	let tool!: ToolDefinition;
	let active: string[] = ["read", "edit", "write"];
	const handlers = new Map<string, Function[]>();
	const pi = {
		on(name: string, fn: Function) {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		registerTool(def: ToolDefinition) { tool = def; },
		getActiveTools: () => active,
		setActiveTools(next: string[]) { active = next; },
	} as unknown as ExtensionAPI;
	sessionRecall(pi);
	return { tool, getActive: () => active, emit: (name: string, ctx: unknown) => handlers.get(name)?.forEach(fn => fn({}, ctx)) };
}

test("recall searches original pre-compaction text, respects branch edits, and pages exact output", async () => {
	const { tool: recall, getActive, emit } = setupRecall();
	const session = SessionManager.inMemory();
	const root = session.appendMessage({ role: "user", content: "最初允许部署 staging。", timestamp: 0 });
	const decision = session.appendMessage({ role: "user", content: "算了，保持 Pi extension 的形态。", timestamp: 0 });
	for (let i = 0; i < 7; i++) {
		session.appendMessage({
			role: "assistant",
			api: "openai-completions", provider: "offline", model: "test", stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [{ type: "text", text: "Pi extension plugin MCP 的旧方案讨论。".repeat(200) }],
			timestamp: 0,
		});
	}
	const removed = session.appendMessage({ role: "user", content: "obsolete-sensitive-value", timestamp: 1 });
	const edited = session.appendMessage({ role: "user", content: "旧边界 production allowed", timestamp: 2 });
	const output = session.appendMessage({
		role: "toolResult", toolCallId: "run", toolName: "exec_command", isError: true,
		content: [{
			type: "text",
			text: "begin: RootCauseParserError imported\n" + "diagnostic line\n".repeat(600)
				+ "RootCauseParserError at parser.ts:42\n" + "tail\n".repeat(600),
		}],
		timestamp: 3,
	});
	const kept = session.appendMessage({ role: "user", content: "继续定位 parser.ts", timestamp: 4 });
	emit("session_start", { sessionManager: session });
	assert.ok(!getActive().includes("session_recall"));

	session.appendCompaction("A summary that forgot the error", kept, 20000, undefined, true);
	emit("session_compact", { sessionManager: session });
	assert.ok(getActive().includes("session_recall"));

	session.appendContextEdit(removed, null);
	session.appendContextEdit(edited, { content: "新边界 production needs approval" });
	const leaf = session.getLeafId()!;
	session.branch(root);
	const sibling = session.appendMessage({ role: "user", content: "sibling-branch-secret", timestamp: 5 });
	session.branch(leaf);

	const before = JSON.stringify(session.getEntries());
	const call = (args: Record<string, unknown>) =>
		recall.execute("test", args, new AbortController().signal, undefined, { sessionManager: session } as never);
	assert.equal(recall.exposure, "direct");
	assert.equal(recall.defaultActive, false);
	assert.equal(((await call({ query: "Pi extension" })).details as { entries: string[] }).entries[0], decision);
	assert.deepEqual(((await call({ query: "extension", role: "user" })).details as { entries: string[] }).entries, [decision]);
	assert.match(textOf(await call({ query: "staging", role: "user" })), /Next user turn .*保持 Pi extension/s);

	const search = await call({ query: "RootCauseParserError parser.ts" });
	assert.equal((search.details as { entries: string[] }).entries[0], output);
	assert.match(textOf(search), /RootCauseParserError at parser\.ts:42/);
	assert.ok(textOf(search).length < 6000);

	const page = await call({ entryId: output, offset: 6000 });
	assert.match(textOf(page), /RootCauseParserError/);
	assert.equal((page.details as { nextOffset?: number }).nextOffset, 12000);

	assert.equal(((await call({ query: '"production needs approval"' })).details as { entries: string[] }).entries[0], edited);
	assert.equal(((await call({ query: 'obsolete-sensitive-value "production allowed" sibling-branch-secret' })).details as { matches: number }).matches, 0);
	await assert.rejects(call({ entryId: sibling }), /current branch/);
	await assert.rejects(call({ entryId: removed }), /current branch/);
	await assert.rejects(call({ entryId: output, role: "user" }), /Use \{entryId/);
	assert.match(textOf(await call({ entryId: output, offset: 20000 })), /End of entry/);
	assert.match(textOf(await call({ query: "extension", role: "user", offset: 5 })), /No more results/);
	assert.equal(JSON.stringify(session.getEntries()), before);
});

test("recall recovers nested codemode calls and shell executions after compaction", async () => {
	const { tool: recall } = setupRecall();
	const session = SessionManager.inMemory();
	const nested = session.appendMessage({
		role: "toolResult", toolCallId: "script", toolName: "codemode", isError: false, timestamp: 1,
		content: [{ type: "text", text: "Done." }],
		nestedCalls: {
			complete: false,
			calls: [
				{ id: "script/1", name: "read", arguments: { path: "nested-only.ts" }, status: "ok" },
				{ id: "script/2", name: "exec_command", arguments: { cmd: "check_nested" }, status: "error", error: "NestedOnlyError" },
			],
		},
	} as never);
	const shell = session.appendMessage({
		role: "bashExecution", command: "shell_probe", timestamp: 2, exitCode: 7, cancelled: false, truncated: false,
		output: "OMITTED BASH MIDDLE\nError: shell middle failure",
	} as never);
	const kept = session.appendMessage({ role: "user", content: "Continue.", timestamp: 3 });
	session.appendCompaction("Compacted.", kept, 5000, undefined, true);

	const call = (args: Record<string, unknown>) =>
		recall.execute("test", args, new AbortController().signal, undefined, { sessionManager: session } as never);
	const nestedSearch = await call({ query: "NestedOnlyError nested-only.ts" });
	assert.equal((nestedSearch.details as { entries: string[] }).entries[0], nested);
	assert.match(textOf(nestedSearch), /nested-only\.ts/);
	const shellSearch = await call({ query: "shell middle failure", role: "toolResult" });
	assert.equal((shellSearch.details as { entries: string[] }).entries[0], shell);
	assert.match(textOf(shellSearch), /OMITTED BASH MIDDLE/);

	session.appendContextEdit(nested, { content: "Visible replacement." });
	const replaced = textOf(await call({ entryId: nested }));
	assert.match(replaced, /Visible replacement\./);
	assert.doesNotMatch(replaced, /nested calls|nested-only\.ts|check_nested|NestedOnlyError|Done\./);
	assert.deepEqual((await call({ query: "nested-only.ts NestedOnlyError check_nested" })).details, { matches: 0, entries: [], nextOffset: undefined });
});

test("entry pages keep surrogate pairs intact at both boundaries", async () => {
	const { tool } = setupRecall();
	const session = SessionManager.inMemory();
	const prefix = "a".repeat(5999 - "[user]\n".length);
	const entryId = session.appendMessage({ role: "user", content: prefix + "😀tail", timestamp: 0 });
	const page = (offset: number) => tool.execute("recall", { entryId, offset }, undefined, undefined, { sessionManager: session } as never);
	const first = await page(0);
	assert.deepEqual(first.details, { entryId, nextOffset: 5999 });
	assert.ok(textOf(first).includes("[user]\n" + prefix + "\nContinue"));
	const next = await page(5999);
	assert.match(textOf(next), /chars 5999–6005 \/ 6005\n😀tail$/);
	assert.deepEqual(next.details, { entryId, nextOffset: undefined });
	assert.deepEqual(await page(6000), next);
});
