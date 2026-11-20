import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import { getModel, getModels, normalizeContext, type FetchFunction } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJiti } from "jiti";
import openRouter, { compareClaudeRelease, openRouterFetch } from "../src/openrouter.ts";
import toolSearch from "../src/tool-search.ts";

async function captureOpenRouter(on: ExtensionAPI["on"] = () => () => {}): Promise<Provider> {
	let registered!: Provider;
	await openRouter({ on, registerProvider: (provider: Provider) => { registered = provider; } } as unknown as ExtensionAPI);
	return registered;
}

test("bundled Pi loads OpenRouter using only Jiti's virtual SDK modules", async t => {
	const dir = await mkdtemp(join(tmpdir(), "pi-prime-bundled-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const entry = join(dir, "openrouter.ts");
	await copyFile(new URL("../src/openrouter.ts", import.meta.url), entry);
	const jiti = createJiti(entry, { tryNative: false, moduleCache: false, virtualModules: {
		"@earendil-works/pi-ai/compat": await import("@earendil-works/pi-ai/compat"),
		"@earendil-works/pi-ai/providers/all": await import("@earendil-works/pi-ai/providers/all"),
		"@earendil-works/pi-coding-agent": await import("@earendil-works/pi-coding-agent"),
	} });
	const register = await jiti.import<typeof openRouter>(entry, { default: true });
	let provider!: Provider;
	await register({ registerProvider: (value: Provider) => { provider = value; } } as ExtensionAPI);
	const id = "~anthropic/claude-opus-latest";
	t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.pathname === "/api/models/providers/openrouter") return new Response(null, { status: 404 });
		assert.equal(url.href, "https://regional.example/api/v1/models/user");
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer offline");
		return Response.json({ data: [{ id, top_provider: { max_completion_tokens: 12345 } }] });
	});
	await provider.refreshModels!({ credential: { type: "api_key", key: "offline" }, baseUrl: "https://regional.example/api/v1",
		allowNetwork: true, signal: new AbortController().signal, publish: async ({ update }) => { update?.(); return true; } });
	assert.deepEqual(provider.getModels().map(model => model.id), [id]);
	const model = provider.getModels()[0] as Model<"anthropic-messages">;
	assert.equal(model.maxTokens, 12345);
	assert.equal(model.compat?.supportsMidConvoToolChanges, true);
	let calls = 0;
	const response = await provider.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] }), {
		apiKey: "offline", fetch: async () => ++calls === 1 ? limited() : reply([{ type: "text", text: "OK" }]),
	}).result();
	assert.equal(calls, 2);
	assert.equal(response.stopReason, "stop");
});

async function registerMockedOpenRouter(pi: ExtensionAPI, fetchOverride: FetchFunction): Promise<void> {
	const provider = await captureOpenRouter(pi.on);
	pi.registerProvider({
		...provider,
		stream<T extends Api>(model: Model<T>, context: Parameters<Provider["stream"]>[1], options?: Parameters<Provider["stream"]>[2]) {
			return provider.stream(model, context, { fetch: fetchOverride, ...options } as never);
		},
		streamSimple(model, context, options) {
			return provider.streamSimple(model, context, { fetch: fetchOverride, ...options });
		},
	});
}

const metadata = { limit_source: "openrouter_in_flight_budget", reason: "in_flight_budget_exhausted" };
const limited = (extra: object = {}, headers: Record<string, string> = { "retry-after": "0.001" }) => Response.json({ error: { message: "private error body", metadata: { ...metadata, ...extra } } }, { status: 402, headers });

test("only structured temporary 402 retries; body, effort and successful response are preserved", async () => {
	const bodies: unknown[] = [];
	const success = new Response("SSE stream", { status: 200, headers: { "x-request-id": "final" } });
	const fetch = openRouterFetch({ fetch: async (_input, init) => { bodies.push(init?.body); return bodies.length === 1 ? limited() : success; } });
	const body = JSON.stringify({ max_tokens: 128000, thinking: { type: "adaptive", effort: "high" } });
	assert.equal(await fetch("https://openrouter.ai/api/v1/messages", { method: "POST", body }), success);
	assert.deepEqual(bodies, [body, body]);
	for (const response of [limited({ reason: "credits_exhausted" }), limited({}, {}), Response.json({ error: { message: "in_flight_budget_exhausted" } }, { status: 402 }), limited({}, { "retry-after": "-1" })]) {
		let calls = 0;
		const fetch = openRouterFetch({ fetch: async () => { calls++; return response; } });
		const failed = await fetch("https://openrouter.ai");
		assert.equal(calls, 1);
		assert.equal(failed.status, 402);
		assert.equal(failed.headers.get("x-should-retry"), "false");
	}
	let calls = 0;
	await openRouterFetch({ maxRetries: 0, fetch: async () => { calls++; return limited(); } })("https://openrouter.ai");
	assert.equal(calls, 1);
});

test("reservation retries stop after three retries or six minutes, and cancellation interrupts waits", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const [seconds, expectedCalls] of [[120, 4], [121, 3], [361, 1]]) {
		let calls = 0;
		const request = openRouterFetch({ fetch: async () => { calls++; return limited({}, { "retry-after": String(seconds), "x-should-retry": "true" }); } })("https://openrouter.ai");
		let settled = false;
		void request.then(() => { settled = true; });
		for (let i = 0; !settled && i < 200; i++) { await nextTick(); t.mock.timers.tick(seconds * 1000); }
		assert.ok(settled, `retry timer did not settle after ${calls} HTTP calls`);
		const response = await request;
		assert.equal(calls, expectedCalls);
		assert.equal(response.headers.get("x-should-retry"), "false");
	}
	const controller = new AbortController();
	let calls = 0;
	const request = openRouterFetch({ signal: controller.signal, fetch: async () => { calls++; return limited({}, { "retry-after": "120" }); } })("https://openrouter.ai");
	const rejected = assert.rejects(request, /abort/i);
	await nextTick(); controller.abort();
	await rejected;
	assert.equal(calls, 1);
});

test("other statuses stay native and embedded Retry-After is supported", async t => {
	for (const status of [401, 429, 500]) {
		const response = Response.json({ metadata }, { status });
		const clone = t.mock.method(response, "clone");
		let calls = 0;
		assert.equal(await openRouterFetch({ fetch: async () => { calls++; return response; } })("https://openrouter.ai"), response);
		assert.equal(calls, 1);
		assert.equal(clone.mock.callCount(), 0);
	}
	let calls = 0;
	const fetch = openRouterFetch({ fetch: async () => ++calls === 1 ? limited({ headers: { "Retry-After": "0.001" } }, {}) : new Response("ok") });
	assert.equal(await (await fetch("https://openrouter.ai")).text(), "ok");
	assert.equal(calls, 2);
});

test("stock Pi retains the conversation and provider usage on disk after an OpenRouter retry", async t => {
	const directory = await mkdtemp(join(tmpdir(), "pi-prime-openrouter-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
	const sessionManager = SessionManager.create(directory, directory);
	let requests = 0;
	const model: Model<"anthropic-messages"> = { provider: "openrouter", api: "anthropic-messages", id: "anthropic/claude-haiku-5.5", name: "Offline Haiku",
		baseUrl: "https://openrouter.ai/api", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 4096,
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } };
	const events = [
		{ type: "message_start", message: { id: "offline-server", type: "message", role: "assistant", model: model.id, content: [], usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 20 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [async pi => {
			await registerMockedOpenRouter(pi, async () => {
				requests++;
				return requests === 1 ? limited() : new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-request-id": "offline-server" } });
			});
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model, settingsManager, sessionManager, resourceLoader: loader, tools: [] });
	t.after(() => session.dispose());
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: error => errors.push(error) });
	session.agent.getApiKey = () => "offline-key";
	await session.agent.prompt("private input");
	assert.equal(requests, 2);
	const last = session.messages.at(-1);
	assert.equal(last?.role, "assistant");
	assert.equal(last?.content[0].type === "text" && last.content[0].text, "OK");
	const other = session.modelRuntime.getModels("openrouter").find(item => item.api === "openai-completions");
	assert.ok(other, "non-Anthropic OpenRouter models remain in the catalog");
	let otherRequests = 0;
	const otherChunks = [
		{ id: "offline-openai", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
		{ id: "offline-openai", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
	];
	const otherReply = await session.modelRuntime.streamSimple(other, { messages: [{ role: "user", content: "offline", timestamp: 0 }] }, {
		apiKey: "offline-key",
		fetch: async () => {
			otherRequests++;
			return otherRequests === 1 ? limited() : new Response(otherChunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "x-request-id": "offline-openai" } });
		},
	}).result();
	assert.equal(otherRequests, 2, "openai-completions OpenRouter models share 402 reservation retries");
	assert.equal(otherReply.stopReason, "stop");
	assert.equal(requests, 2);
	assert.deepEqual(errors, []);
	const reopened = SessionManager.open(sessionManager.getSessionFile()!).getEntries();
	assert.deepEqual(reopened.filter(entry => entry.type === "custom"), []);
	const savedMessages = reopened.filter(entry => entry.type === "message").map(entry => entry.message);
	assert.ok(savedMessages.some(item => item.role === "user" && JSON.stringify(item.content).includes("private input")));
	const savedReply = savedMessages.find(item => item.role === "assistant");
	assert.ok(savedReply?.role === "assistant" && savedReply.content.some(block => block.type === "text" && block.text === "OK"));
	assert.equal(savedReply.responseId, "offline-server");
	assert.equal(savedReply.usage.cacheRead, 20);
});

test("OpenRouter registration restores the SDK's saved personalized catalog", async t => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("The catalog restoration test runs offline"); });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openrouter", async () => ({ type: "api_key", key: "offline-key" }));
	const store = new InMemoryModelsStore();
	const model = getModel("openrouter", "~anthropic/claude-fable-latest");
	const personalized = { ...model, name: "Personal catalog entry", maxTokens: 12345 };
	await store.write("openrouter", { models: [personalized], checkedAt: Date.now() });
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: store, refreshOnCreate: false });
	const pi = { on: () => () => {},
		registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider) } as unknown as ExtensionAPI;
	await openRouter(pi);
	await runtime.refresh({ allowNetwork: false });
	assert.equal(typeof runtime.getProvider("openrouter")?.refreshModels, "function");
	assert.deepEqual(runtime.getModels("openrouter").map(model => model.name), ["Personal catalog entry"]);
	assert.equal(runtime.getModel("openrouter", model.id)?.maxTokens, 12345);
	const restored = runtime.getModel("openrouter", model.id) as Model<"anthropic-messages">;
	assert.equal(restored.compat?.supportsMidConvoToolChanges, true);
});

function reply(blocks: any[], stopReason = "end_turn", usage: {
	input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
} = { input_tokens: 1, output_tokens: 1 }, id = "offline-tools") {
	const { output_tokens, ...inputUsage } = usage;
	const events = [
		{ type: "message_start", message: { id, type: "message", role: "assistant", content: [], usage: { ...inputUsage, output_tokens: 0 } } },
		...blocks.flatMap((block, index) => [
			{ type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} } : block },
			...(block.type === "tool_use" ? [{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }] : []),
			{ type: "content_block_stop", index },
		]),
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("OpenRouter passes Pi's native idle warm request through unchanged", async t => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in cache warm test"); });
	const directory = await mkdtemp(join(tmpdir(), "pi-prime-claude-warm-"));
	t.after(() => {
		assert.ok(directory.startsWith(join(tmpdir(), "pi-prime-claude-warm-")));
		return rm(directory, { recursive: true, force: true });
	});
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "idle", compaction: { enabled: false }, retry: { enabled: false } });
	const sessionManager = SessionManager.inMemory(directory);
	const model = getModel("openrouter", "anthropic/claude-opus-5.5");
	const modelsPath = join(directory, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers: { openrouter: { modelOverrides: {
		[model.id]: { promptCache: { short: 60 }, cost: { input: 4, output: 20, cacheRead: .2, cacheWrite: 5 } },
	} } } }));
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openrouter", async () => ({ type: "api_key", key: "offline-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath,
		modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
	const payloads: any[] = [];
	const sessionHeaders: (string | null)[] = [];
	const fixtures = [
		{ text: "Original final reply", input_tokens: 0, output_tokens: 60, cache_creation_input_tokens: 120000 },
		{ text: "Discarded warm output", input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 120000, cache_creation_input_tokens: 60 },
		{ text: "New final reply", input_tokens: 0, output_tokens: 500, cache_creation_input_tokens: 100000 },
	];
	const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [async pi => {
			await registerMockedOpenRouter(pi, async (_input, init) => {
				const fixture = fixtures[payloads.length];
				assert.ok(fixture, "unexpected warm request");
				payloads.push(JSON.parse(init!.body as string));
				sessionHeaders.push(new Headers(init?.headers).get("x-session-id"));
				const { text, ...usage } = fixture;
				return reply([{ type: "text", text }], "end_turn", usage, `offline-${payloads.length}`);
			});
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model, modelRuntime,
		settingsManager, sessionManager, resourceLoader: loader, tools: [] });
	t.after(() => session.dispose());
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: error => errors.push(error) });
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
	const warms = () => sessionManager.getEntries().filter(entry => entry.type === "usage" && entry.kind === "cache_warm");
	async function advanceToWarm(count: number) {
		assert.equal(session.cacheWarmingStatus?.state, "scheduled", JSON.stringify(session.cacheWarmingStatus));
		t.mock.timers.tick(54000);
		for (let index = 0; index < 100 && warms().length < count; index++) await nextTick();
		assert.equal(warms().length, count, JSON.stringify({ requests: payloads.length, status: session.cacheWarmingStatus, errors }));
	}

	await session.prompt("Original real input");
	assert.equal(payloads.length, 1, "wait for the native timer before spending on the reply");
	const originalTranscript = JSON.stringify(session.messages);
	await advanceToWarm(1);
	assert.equal(payloads[1].max_tokens, 1);
	assert.deepEqual(payloads[1].system, payloads[0].system);
	assert.deepEqual(payloads[1].messages, payloads[0].messages);
	assert.equal(JSON.stringify(session.messages), originalTranscript);
	await session.prompt("Actual next user message");
	const next = JSON.stringify(payloads[2].messages);
	assert.match(next, /Original final reply/);
	assert.match(next, /Actual next user message/);
	assert.doesNotMatch(next, /Discarded warm output/);
	assert.ok(sessionHeaders.every(id => id === sessionManager.getSessionId()));
	assert.deepEqual(errors, []);
});

test("deferred tool discovery and later user turns keep system prefixes fixed without inline system support", async t => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in offline prefix test"); });
	const gemini = getModels("openrouter").find(item => item.api === "openai-completions" && item.id.startsWith("google/gemini"));
	assert.ok(gemini);
	const sonnet = getModel("openrouter", "anthropic/claude-sonnet-5");
	for (const model of [gemini, sonnet] as const) {
		const directory = await mkdtemp(join(tmpdir(), "pi-prime-prefix-"));
		t.after(() => {
			assert.ok(directory.startsWith(join(tmpdir(), "pi-prime-prefix-")));
			return rm(directory, { recursive: true, force: true });
		});
		const settingsManager = SettingsManager.inMemory({ extensions: ["-builtin:tool-search"], cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
		const sessionManager = SessionManager.inMemory(directory);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openrouter", async () => ({ type: "api_key", key: "offline-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null,
			modelsStorePath: join(directory, "catalog.json"), refreshOnCreate: false });
		const payloads: any[] = [];
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [toolSearch, async pi => {
				pi.on("before_agent_start", ({ systemPromptOptions }) => {
					systemPromptOptions.promptGuidelines.push("Deferred tools: doc_search, doc_fetch.");
				});
				const noop = async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined });
				pi.registerTool({ name: "doc_search", label: "Doc Search", description: "Search docs.", exposure: "deferred", parameters: Type.Object({}), execute: noop });
				pi.registerTool({ name: "doc_fetch", label: "Doc Fetch", description: "Fetch a doc.", exposure: "deferred", parameters: Type.Object({}), execute: noop });
				await registerMockedOpenRouter(pi, async (_input, init) => {
					payloads.push(JSON.parse(init!.body as string));
					const discover = payloads.length === 1;
					const args = { query: "doc_search doc_fetch", limit: 2 };
					if (model.api === "anthropic-messages") return reply(discover
						? [{ type: "tool_use", id: "doc-load", name: "tool_search", input: args }]
						: [{ type: "text", text: "DONE" }], discover ? "tool_use" : "end_turn");
					const chunks = [
						{ id: "offline-doc", choices: [{ index: 0, delta: discover
							? { role: "assistant", tool_calls: [{ index: 0, id: "doc-load", type: "function", function: { name: "tool_search", arguments: JSON.stringify(args) } }] }
							: { role: "assistant", content: "DONE" }, finish_reason: null }] },
						{ id: "offline-doc", choices: [{ index: 0, delta: {}, finish_reason: discover ? "tool_calls" : "stop" }] },
					];
					return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
				});
			}],
		});
		await loader.reload();
		const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model, modelRuntime, settingsManager, sessionManager,
			resourceLoader: loader, tools: ["tool_search", "doc_search", "doc_fetch"] });
		t.after(() => session.dispose());
		await session.bindExtensions({});
		session.setActiveToolsByName(["tool_search"]);
		await session.prompt("Load the deferred doc tools.");
		for (const name of ["doc_search", "doc_fetch"]) assert.ok(session.getActiveToolNames().includes(name), JSON.stringify({ model: model.id, messages: session.messages }));
		await session.prompt("Continue with the loaded tools.");
		await session.reload();
		await session.prompt("Continue after reloading the extensions.");
		assert.equal(payloads.length, 4, model.id);
		const system = (payload: any) => model.api === "anthropic-messages" ? payload.system
			: payload.messages.filter((message: any) => message.role === "system" || message.role === "developer");
		assert.match(JSON.stringify(system(payloads[0])), /Deferred tools:/);
		for (const payload of payloads.slice(1)) assert.deepEqual(system(payload), system(payloads[0]), model.id);
	}
});

for (const modelId of ["anthropic/claude-opus-5.5", "anthropic/claude-fable-5.2", "anthropic/claude-haiku-5.5", "~anthropic/claude-fable-latest", "~anthropic/claude-opus-latest", "~anthropic/claude-sonnet-latest", "~anthropic/claude-haiku-latest"] as const) test(`tool_search keeps the OpenRouter prefix stable for ${modelId}`, async t => {
	const directory = await mkdtemp(join(tmpdir(), "pi-prime-inline-tools-"));
	t.after(() => {
		assert.ok(directory.startsWith(join(tmpdir(), "pi-prime-inline-tools-")));
		return rm(directory, { recursive: true, force: true });
	});
	const settingsManager = SettingsManager.inMemory({ extensions: ["-builtin:tool-search", "-builtin:codemode"], cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } });
	const sessionManager = SessionManager.inMemory(directory);
	const payloads: any[] = [], headers: Headers[] = [], values: string[] = [];
	const model = getModel("openrouter", modelId);
	const original = structuredClone(model);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openrouter", async () => ({ type: "api_key", key: "offline-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials,
		modelsPath: null, modelsStorePath: join(directory, "catalog.json"), refreshOnCreate: false });
	const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [toolSearch, async pi => {
			pi.registerTool({ name: "cache_probe", label: "Cache probe", description: "Return a supplied marker.", exposure: "deferred",
				parameters: Type.Object({ value: Type.String() }),
				async execute(_id, { value }) { values.push(value); return { content: [{ type: "text", text: value }], details: undefined }; },
			});
			await registerMockedOpenRouter(pi, async (_input, init) => {
				payloads.push(JSON.parse(init!.body as string)); headers.push(new Headers(init?.headers));
				if (payloads.length === 1) return reply([
					{ type: "thinking", thinking: "Find the marker tool first.", signature: "preserve-this-signature" },
					{ type: "tool_use", id: "search-1", name: "tool_search", input: { query: "cache_probe", limit: 1 } },
				], "tool_use");
				if (payloads.length === 2) return reply([{ type: "tool_use", id: "probe-1", name: "cache_probe", input: { value: "CALLED" } }], "tool_use");
				return reply([{ type: "text", text: "DONE" }]);
			});
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model, modelRuntime, settingsManager, sessionManager, resourceLoader: loader, tools: ["tool_search", "cache_probe"] });
	t.after(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	await session.bindExtensions({});
	session.setActiveToolsByName(["tool_search"]);
	await session.prompt("Find cache_probe and call it with CALLED.");
	await session.prompt("Continue with the same tools.");
	assert.deepEqual(values, ["CALLED"], JSON.stringify(session.messages));
	assert.equal(payloads.length, 4);
	assert.ok(!payloads[0].tools.some((tool: any) => tool.name === "cache_probe"));
	assert.ok(payloads[0].tools.some((tool: any) => tool.defer_loading), "deferred scaffolding must be cached from the first request");
	for (let i = 1; i < payloads.length; i++) {
		assert.deepEqual(payloads[i].tools, payloads[0].tools, "tool_search must keep the top-level tool definitions fixed");
		assert.deepEqual(payloads[i].system, payloads[0].system);
		assert.match(JSON.stringify(payloads[i].messages), /preserve-this-signature/);
		assert.match(headers[i].get("anthropic-beta") ?? "", /inline-tools-2026-09-15/);
	}
	const additions = payloads[1].messages.filter((message: any) => message.role === "system")
		.flatMap((message: any) => message.content).filter((block: any) => block.type === "tool_addition");
	assert.equal(additions.length, 1);
	assert.equal(additions[0].tool.type, "tool_definition");
	assert.equal(additions[0].tool.definition.name, "cache_probe");
	assert.deepEqual(model, original, "request overrides must not mutate the model catalog");
});

test("inline tools follow native model capabilities and preserve explicit compatibility overrides", async () => {
	const provider = await captureOpenRouter();
	const tool = { name: "original", description: "Original tool", parameters: Type.Object({}) };
	const context = normalizeContext({ messages: [{ role: "system", content: "Use tools.", toolsAdded: [tool], timestamp: 0 }, { role: "user", content: "Hello", timestamp: 1 }] });
	for (const id of ["anthropic/claude-haiku-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-fable-5", "~anthropic/claude-fable-latest", "~anthropic/claude-opus-latest", "~anthropic/claude-sonnet-latest", "~anthropic/claude-haiku-latest", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-4.8", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5"] as const) {
		const base = getModel("openrouter", id);
		for (const disable of [false, true]) {
			const model = disable ? { ...base, compat: { ...base.compat, supportsMidConvoToolChanges: false } } : base;
			let payload: any;
			await provider.streamSimple(model, context, { apiKey: "offline", maxRetries: 0, fetch: async (_input, init) => { payload = JSON.parse(init!.body as string); return reply([{ type: "text", text: "OK" }]); } }).result();
			const supported = !disable && !["anthropic/claude-sonnet-5", "anthropic/claude-haiku-4.5"].includes(id);
			assert.equal(payload.tools.some((tool: any) => tool.defer_loading), supported, `${id}, explicit disable=${disable}`);
		}
	}
	for (const id of ["~anthropic/claude-unknown-latest", "~anthropic/claude-opus-preview"]) {
		const model = { ...getModel("openrouter", "~anthropic/claude-opus-latest"), id };
		let payload: any;
		await provider.streamSimple(model, context, { apiKey: "offline", maxRetries: 0, fetch: async (_input, init) => { payload = JSON.parse(init!.body as string); return reply([{ type: "text", text: "OK" }]); } }).result();
		assert.ok(!payload.tools.some((tool: any) => tool.defer_loading), id);
	}
});

test("compareClaudeRelease ranks minor versions above dated snapshots of earlier releases", () => {
	assert.ok(compareClaudeRelease("claude-sonnet-5-5", "claude-sonnet-5-20260201") > 0);
	assert.ok(compareClaudeRelease("claude-sonnet-5-10", "claude-sonnet-5-9") > 0);
	assert.ok(compareClaudeRelease("claude-sonnet-5-5-20260601", "claude-sonnet-5-5") > 0);
	assert.ok(compareClaudeRelease("claude-sonnet-5-20260201", "claude-sonnet-5") > 0);
});
