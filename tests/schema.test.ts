import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { getModels, streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import sessionRecall from "../src/session-recall.ts";
import terminal from "../src/terminal/index.ts";

test("optional tool enums validate all choices and reach OpenRouter as plain JSON Schema", async () => {
	const registered = new Map<string, ToolDefinition>();
	const pi = { on() {}, registerCommand() {}, registerTool(tool: ToolDefinition) { registered.set(tool.name, tool); } } as unknown as ExtensionAPI;
	sessionRecall(pi);
	terminal(pi);
	const cases: { name: string; field: string; values: string[]; base: Record<string, string> }[] = [
		{ name: "session_recall", field: "role", values: ["user", "assistant", "toolResult", "custom", "compaction", "branch_summary"], base: { query: "fixture" } },
		{ name: "terminal_sessions", field: "action", values: ["list", "close"], base: {} },
	];
	for (const { name, field, values, base } of cases) {
		const tool = registered.get(name)!;
		const validate = (args: Record<string, string>) => validateToolArguments(tool, { type: "toolCall", id: "enum-test", name, arguments: args });
		validate(base);
		for (const value of values) assert.equal(validate({ ...base, [field]: value })[field], value);
		assert.throws(() => validate({ ...base, [field]: "invalid" }), error => {
			assert.match(String(error), /expected one of/);
			for (const value of values) assert.ok(String(error).includes(`"${value}"`));
			return true;
		});
	}
	let payload: any;
	const model = getModels("openrouter").find(item => item.api === "openai-completions" && item.id.startsWith("google/gemini"));
	assert.ok(model);
	await streamSimple(model, {
		messages: [{ role: "user", content: "Offline schema probe", timestamp: 0 }],
		tools: cases.map(({ name }) => registered.get(name)!),
	}, {
		apiKey: "offline-test", maxRetries: 0,
		fetch: async (_input, init) => {
			payload = JSON.parse(init!.body as string);
			return Response.json({ error: { message: "offline schema capture" } }, { status: 400 });
		},
	}).result();
	for (const { name, field, values } of cases) {
		const parameters = payload.tools.find((tool: any) => tool.function.name === name).function.parameters;
		assert.equal(parameters.properties[field].type, "string");
		assert.deepEqual(parameters.properties[field].enum, values);
		assert.equal(parameters.properties[field].anyOf, undefined);
		assert.doesNotMatch(JSON.stringify(parameters), /"~(?:kind|optional|unsafe)"/);
	}
});
