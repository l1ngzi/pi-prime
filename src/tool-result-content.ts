import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export default function toolResultContent(pi: ExtensionAPI): void {
	const encoded = new WeakSet<object>();
	pi.on("before_provider_request", ({ payload }, ctx) => {
		if (!record(payload) || !Array.isArray(payload.messages)) return;
		if (ctx.model?.provider !== "openrouter" || ctx.model.api !== "openai-completions"
			|| typeof payload.model !== "string" || !/^~?google\/gemini-/.test(payload.model)) return;
		let changed = false;
		const messages = payload.messages.map(message => {
			if (!record(message) || message.role !== "tool" || typeof message.content !== "string" || encoded.has(message)) return message;
			// OpenRouter's Gemini bridge can infer JSON from fragments of tool text.
			// Supply a complete object on this route so surrounding text survives.
			// Always encode the whole text, including text that happens to be JSON.
			const result = { ...message, content: JSON.stringify({ output: message.content }) };
			encoded.add(result);
			changed = true;
			return result;
		});
		return changed ? { ...payload, messages } : undefined;
	});
}
