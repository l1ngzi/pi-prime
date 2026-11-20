import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import toolResultContent from "../src/tool-result-content.ts";

const gemini = { provider: "openrouter", api: "openai-completions", id: "google/gemini-4-flash" };

function setup(model: { provider: string; api: string; id: string } = gemini) {
	let hook!: (event: { payload: unknown }, context: unknown) => any;
	toolResultContent({ on: (event: string, handler: typeof hook) => {
		assert.equal(event, "before_provider_request");
		hook = handler;
	} } as unknown as ExtensionAPI);
	return (payload: unknown) => hook({ payload }, { model });
}

const receipts = [
	'Exit 1\nBEFORE\n{"step":"init","ok":true}\nWrite-Error: FATAL\n',
	'Script failed\nCall write_stdin({session_id:611137}).\nGIT_LOG\nGIT_SHOW\n',
	String.raw`C:\Users\probe\first.ts` + "\r\n" + String.raw`D:\work\new\tab\file.log`,
	'{"output":"business data","error":false,"result":7}',
	'first {"a":1}\nsecond {"b":2}\nlast',
	'```json\n{"status":"ok"}\n```\nFAILURE after the code block',
	'重复键: 第一行\n重复键: 第二行\n[1,2,3]\n结束 🧪',
	"", " ", "null", "false", "42", '"quoted"', "[1,2,3]", "\u0000\t\r\n\b\f\\n\\u0041",
];

test("complete tool text survives decoding, including JSON-shaped data, errors and arbitrary escapes", () => {
	const encode = setup();
	const image = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] };
	const texts = [...receipts, ...Array.from({ length: 64 }, (_, i) =>
		String.fromCharCode(i) + receipts[i % receipts.length] + String.fromCodePoint(0x1f600 + i))];
	const payload = { model: gemini.id, messages: [
		{ role: "assistant", content: "unchanged" },
		...texts.map((content, i) => ({ role: "tool", tool_call_id: `call_${i}`, name: "probe", content })), image,
	], stream: true };
	const original = structuredClone(payload);
	const result = encode(payload);
	assert.deepEqual(payload, original);
	assert.equal(result.stream, true);
	assert.equal(result.messages[0], payload.messages[0]);
	assert.equal(result.messages.at(-1), image);
	for (const [i, text] of texts.entries()) {
		const message = result.messages[i + 1];
		assert.equal(message.tool_call_id, `call_${i}`);
		assert.equal(message.name, "probe");
		assert.deepEqual(JSON.parse(message.content), { output: text });
	}
});

test("Gemini bridge encoding stays stable on retries and reused message objects", () => {
	const encode = setup();
	const message = { role: "tool", tool_call_id: "probe", content: receipts[0] };
	const payload = { model: gemini.id, messages: [message] };
	const result = encode(payload);
	assert.deepEqual(encode(payload), result);
	assert.equal(encode(result), undefined);
	assert.equal(encode({ ...result }), undefined);
	const mixed = encode({ model: gemini.id, messages: [result.messages[0], message] });
	assert.equal(mixed.messages[0], result.messages[0]);
	assert.equal(mixed.messages[1].content, result.messages[0].content);
	for (const model of ["google/gemini-3-flash-preview", "~google/gemini-flash-latest", "google/gemini-4-pro"]) {
		const current = encode({ model, messages: [message] });
		assert.equal(current.messages[0].content, result.messages[0].content);
	}
});

test("other routes keep plain tool strings, including local models and non-Gemini OpenRouter requests", () => {
	for (const model of [
		{ ...gemini, provider: "autodl-flash", id: "qwen" },
		{ ...gemini, provider: "modal", id: "qwen" },
		{ ...gemini, id: "meta/muse-spark" },
		{ ...gemini, provider: "google", api: "google-generative-ai" },
		{ ...gemini, api: "anthropic-messages", id: "anthropic/claude-sonnet-5.5" },
	]) {
		const payload = { model: model.id, messages: receipts.map(content => ({ role: "tool", content })) };
		const before = structuredClone(payload);
		assert.equal(setup(model)(payload), undefined, JSON.stringify(model));
		assert.deepEqual(payload, before);
	}
	// Inspect the actual payload as well as the selected model: a different request
	// can pass through the hook during a model switch or background work.
	assert.equal(setup()({ model: "meta/muse-spark", messages: [{ role: "tool", content: receipts[0] }] }), undefined);
	assert.equal(setup({ ...gemini, provider: "local" })({ model: gemini.id, messages: [{ role: "tool", content: receipts[0] }] }), undefined);
});

test("native structured protocols and non-tool messages retain their original payloads", () => {
	const encode = setup();
	for (const payload of [null, [], "text", {}, { messages: null },
		{ input: [{ type: "function_call_output", output: receipts[0] }] },
		{ contents: [{ role: "user", parts: [{ functionResponse: { response: { output: receipts[0] } } }] }] },
		{ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: receipts[0], is_error: true }] }] },
		{ messages: [null, { role: "assistant", content: receipts[0] }, { role: "tool", content: null }] }]) {
		const original = structuredClone(payload);
		assert.equal(encode(payload), undefined);
		assert.deepEqual(payload, original);
	}
});

for (const route of [gemini, { ...gemini, provider: "modal", id: "local-qwen" }, { ...gemini, id: "meta/muse-spark" }]) test(`Pi preserves receipts, images and persisted errors for ${route.provider}/${route.id}`, async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-prime-tool-content-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
	const content = [
		{ type: "text" as const, text: receipts[0] },
		{ type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" },
		{ type: "text" as const, text: receipts.slice(1).join("\n") },
	];
	const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
		extensionFactories: [toolResultContent, pi => pi.registerTool({
			name: "receipt_probe", label: "Receipt probe", description: "Return a synthetic receipt.", parameters: Type.Object({}),
			async execute() { return { content, details: undefined, isError: true }; },
		})], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const manager = SessionManager.inMemory(cwd);
	const model = { ...route, api: "openai-completions" as const, name: "Offline test model",
		baseUrl: "http://127.0.0.1", reasoning: false, input: ["text" as const, "image" as const], contextWindow: 8192, maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const { session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, resourceLoader: loader, sessionManager: manager,
		model, tools: ["receipt_probe"] });
	t.after(() => session.dispose());
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: error => errors.push(error) });
	session.agent.getApiKey = () => "offline-test";
	const requests: any[] = [];
	session.agent.streamFunction = (_model, context, options) => streamSimple(model, context, { ...options, apiKey: "offline-test", maxRetries: 0,
		fetch: async (_url, init) => {
			requests.push(JSON.parse(init!.body as string));
			const first = requests.length === 1;
			const chunk = { id: "offline", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0,
				delta: first ? { role: "assistant", tool_calls: [{ index: 0, id: "probe_call", type: "function", function: { name: "receipt_probe", arguments: "{}" } }] }
					: { role: "assistant", content: "done" }, finish_reason: first ? "tool_calls" : "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		} });
	await session.agent.prompt("Read the fixture.");
	assert.deepEqual(errors, []);
	assert.equal(requests.length, 2);
	const wire = requests[1].messages.find((message: any) => message.role === "tool");
	const expected = content.filter(c => c.type === "text").map(c => c.text).join("\n");
	assert.equal(wire.content, route === gemini ? JSON.stringify({ output: expected }) : expected);
	const images = requests[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
		.filter((part: any) => part.type === "image_url");
	assert.deepEqual(images, [{ type: "image_url", image_url: { url: `data:image/png;base64,${content[1].data}` } }]);
	const entry = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult");
	assert.ok(entry?.type === "message" && entry.message.role === "toolResult");
	assert.equal(entry.message.isError, true);
	assert.deepEqual(entry.message.content, content);
});
