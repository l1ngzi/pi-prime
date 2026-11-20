import { getModels, InMemoryCredentialStore, type Api, type FetchFunction, type Model, type StreamOptions } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import timers from "node:timers/promises";

// OpenRouter's Messages API accepts inline tool definitions. Reuse Pi's native
// Anthropic capability catalog, including its exclusions for older Claude models.
// https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message.md
const nativeModels = getModels("anthropic");
const inlineToolModels = new Set(nativeModels
	.filter(model => model.compat?.supportsMidConvoSystemMessages && model.compat?.supportsMidConvoToolChanges)
	.map(model => model.id));

// Compare parsed release segments before any trailing YYYYMMDD snapshot date so
// e.g. claude-sonnet-5-5 outranks claude-sonnet-5-20260201 and 5-10 outranks 5-9.
export function compareClaudeRelease(a: string, b: string): number {
	const parse = (id: string) => {
		const suffix = /^claude-[a-z]+-(.+)$/.exec(id)?.[1] ?? "";
		const parts = suffix.split("-");
		const date = /^\d{8}$/.test(parts.at(-1) ?? "") ? Number(parts.pop()) : 0;
		return { version: parts.map(part => /^\d+$/.test(part) ? Number(part) : -1), date };
	};
	const left = parse(a), right = parse(b);
	const length = Math.max(left.version.length, right.version.length);
	for (let i = 0; i < length; i++) {
		const diff = (left.version[i] ?? 0) - (right.version[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return left.date - right.date || a.localeCompare(b, "en", { numeric: true });
}

// Latest aliases follow the newest release in each family.
// https://openrouter.ai/~anthropic/claude-opus-latest
const latestFamilyModels = new Map<string, (typeof nativeModels)[number]>();
for (const model of nativeModels) {
	const family = /^(claude-[a-z]+)-\d/.exec(model.id)?.[1];
	if (!family) continue;
	const previous = latestFamilyModels.get(family);
	if (!previous || compareClaudeRelease(model.id, previous.id) > 0) latestFamilyModels.set(family, model);
}

function withInlineTools<T extends Api>(model: Model<T>): Model<T> {
	if (model.provider !== "openrouter" || model.api !== "anthropic-messages") return model;
	const name = /^~?anthropic\/(claude-[\w.-]+)$/.exec(model.id)?.[1];
	if (!name) return model;
	const family = /^(claude-[a-z]+)-latest$/.exec(name)?.[1];
	const native = family ? latestFamilyModels.get(family)?.id : name.replaceAll(".", "-");
	if (!native || !inlineToolModels.has(native)) return model;
	const compat = (model as Model<"anthropic-messages">).compat;
	if (compat?.supportsMidConvoSystemMessages !== undefined && compat.supportsMidConvoToolChanges !== undefined) return model;
	return { ...model, compat: { ...compat,
		supportsMidConvoSystemMessages: compat?.supportsMidConvoSystemMessages ?? true,
		supportsMidConvoToolChanges: compat?.supportsMidConvoToolChanges ?? true,
	} } as Model<T>;
}

async function reservationRetryDelay(response: Response): Promise<number | undefined> {
	let body: any;
	try { body = await response.clone().json(); } catch { return; }
	const metadata = body?.metadata ?? body?.error?.metadata;
	if (metadata?.limit_source !== "openrouter_in_flight_budget" || metadata.reason !== "in_flight_budget_exhausted") return;
	const header = response.headers.get("retry-after") ?? metadata.headers?.["Retry-After"] ?? metadata.headers?.["retry-after"];
	if (typeof header !== "string") return;
	const wait = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
	return Number.isFinite(wait) && wait > 0 ? wait : undefined;
}

// Request-scoped transport: Pi keeps its normal handling for every other status.
// Only explicit temporary reservation errors qualify, with at most three waits
// totalling six minutes. Never reduce the model's tokens or reasoning to fit.
export function openRouterFetch(options: Pick<StreamOptions, "fetch" | "signal" | "maxRetries"> = {}): FetchFunction {
	const fetch = options.fetch ?? globalThis.fetch;
	let retries = 0, waited = 0;
	return async (input, init) => {
		const signal = options.signal ?? init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
		for (;;) {
			signal?.throwIfAborted();
			const response = await fetch(input instanceof Request ? input.clone() : input, init);
			if (response.status !== 402) return response;
			const wait = options.maxRetries === 0 || retries >= 3 ? undefined : await reservationRetryDelay(response);
			if (wait === undefined || waited + wait > 360_000) {
				// Prevent native retries of credit errors or a spent reservation budget,
				// including servers that return x-should-retry: true for all failures.
				const headers = new Headers(response.headers);
				headers.set("x-should-retry", "false");
				return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
			}
			retries++; waited += wait;
			await response.body?.cancel();
			await timers.setTimeout(wait, undefined, { signal });
		}
	};
}

export default async function openRouter(pi: ExtensionAPI): Promise<void> {
	// The SDK supplies the personalized catalog. The host applies its credentials,
	// stored models and models.json overrides when it registers this provider.
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const provider = runtime.getProvider("openrouter");
	if (!provider) throw new Error("Built-in OpenRouter provider is unavailable.");
	pi.registerProvider({
		...provider,
		getModels: () => provider.getModels().map(withInlineTools),
		getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).map(model =>
			model.type === undefined || model.type === "chat" ? withInlineTools(model) : model),
		stream(model, context, options) {
			return provider.stream(withInlineTools(model), context, Object.assign({}, options, { fetch: openRouterFetch(options) }));
		},
		streamSimple(model, context, options) {
			return provider.streamSimple(withInlineTools(model), context, { ...options, fetch: openRouterFetch(options) });
		},
	});
}
