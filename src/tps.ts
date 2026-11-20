/**
 * A small, themed TPS indicator in Pi's native footer.
 *
 * Live: a rolling four-second estimate of streamed text, thinking and tool JSON.
 * Final: estimated streamed tokens / time from first to last output chunk.
 * Both rates use visible text, thinking and tool JSON, marked with "≈".
 * Buffered delivery can cause occasional spikes; request time is shown separately.
 * No history scans, transcript entries, external dependencies or startup noise.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tps";
const WINDOW_MS = 4_000;
const REFRESH_MS = 200;
const MIN_RATE_MS = 250;
const encoder = new TextEncoder();

interface Sample {
	time: number;
	tokens: number;
}

interface Generation {
	startedAt: number;
	requestStarted: boolean;
	firstOutputAt?: number;
	lastOutputAt?: number;
	estimatedTokens: number;
	samples: Sample[];
}

// Providers rarely expose a live token count. Keep fractions across deltas so
// one-character chunks are not mistaken for one token each. CJK needs a different
// approximation from English/code; these are estimates, never tokenizer claims.
function estimateTokens(text: string): number {
	let cjk = 0;
	const rest = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, () => {
		cjk++;
		return "";
	});
	return cjk + encoder.encode(rest).length / 4;
}

function estimateMessage(message: AssistantMessage): number {
	let tokens = 0;
	for (const block of message.content) {
		if (block.type === "text") tokens += estimateTokens(block.text);
		else if (block.type === "thinking") tokens += estimateTokens(block.thinking);
		else if (block.type === "toolCall") {
			tokens += estimateTokens(block.name + JSON.stringify(block.arguments));
		}
	}
	return tokens;
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return Math.round(tokens).toString();
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, milliseconds) / 1_000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

export default function (pi: ExtensionAPI) {
	let generation: Generation | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let agentRunning = false;

	function stopTimer() {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	}

	function reset(ctx: ExtensionContext) {
		stopTimer();
		generation = undefined;
		agentRunning = false;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function renderLive(ctx: ExtensionContext) {
		if (!ctx.hasUI || !generation) return;
		const now = performance.now();
		const { samples, estimatedTokens, startedAt, firstOutputAt } = generation;
		samples.push({ time: now, tokens: estimatedTokens });
		const cutoff = Math.max(firstOutputAt ?? startedAt, now - WINDOW_MS);
		// Retain one sample before the boundary to interpolate the window's start.
		while (samples.length > 2 && samples[1].time <= cutoff) samples.shift();
		const first = samples[0];
		const next = samples[1];
		let baseline = first.tokens;
		if (next && first.time < cutoff && next.time > first.time) {
			baseline += (next.tokens - first.tokens) * ((cutoff - first.time) / (next.time - first.time));
		}
		const elapsed = now - cutoff;
		const theme = ctx.ui.theme;
		const dot = theme.fg("accent", "●");
		const duration = theme.fg("dim", ` · ${formatDuration(now - startedAt)}`);
		if (estimatedTokens <= 0) {
			ctx.ui.setStatus(STATUS_KEY, dot + theme.fg("dim", " waiting") + duration);
			return;
		}
		const rate = elapsed >= MIN_RATE_MS ? Math.max(0, estimatedTokens - baseline) * 1_000 / elapsed : undefined;
		const value = rate === undefined ? "≈—" : `≈${rate.toFixed(1)}`;
		ctx.ui.setStatus(STATUS_KEY, dot + " " + theme.fg("accent", theme.bold(value)) + theme.fg("dim", " tok/s") + duration);
	}

	function start(ctx: ExtensionContext) {
		stopTimer();
		if (!ctx.hasUI) return;
		const startedAt = performance.now();
		generation = {
			startedAt,
			requestStarted: false,
			estimatedTokens: 0,
			samples: [{ time: startedAt, tokens: 0 }],
		};
		renderLive(ctx);
		timer = setInterval(() => renderLive(ctx), REFRESH_MS);
		timer.unref();
	}

	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => reset(ctx));
	pi.on("session_tree", (_event, ctx) => reset(ctx));
	pi.on("model_select", (_event, ctx) => {
		if (!agentRunning) reset(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		reset(ctx);
		agentRunning = true;
	});

	pi.on("turn_start", (_event, ctx) => start(ctx));

	pi.on("before_provider_request", (_event, ctx) => {
		// Anchor once: retries or background hooks must not shorten this request.
		if (agentRunning && generation && !generation.requestStarted) {
			start(ctx);
			if (generation) generation.requestStarted = true;
		}
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant" || !ctx.hasUI) return;
		if (!generation) start(ctx);
		if (generation) generation.requestStarted = true;
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant" || !ctx.hasUI || !generation) return;
		const delta = event.assistantMessageEvent;
		let tokens = 0;
		if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") {
			tokens = estimateTokens(delta.delta);
		} else if (delta.type === "toolcall_start") {
			const block = event.message.content[delta.contentIndex];
			if (block?.type === "toolCall") {
				tokens += estimateTokens(block.name);
				if (Object.keys(block.arguments).length > 0) {
					tokens += estimateTokens(JSON.stringify(block.arguments));
				}
			}
		}
		generation.estimatedTokens += tokens;
		if (tokens > 0) {
			const now = performance.now();
			if (generation.firstOutputAt === undefined) {
				generation.firstOutputAt = now;
				generation.samples = [{ time: now, tokens: 0 }];
			}
			generation.lastOutputAt = now;
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || !ctx.hasUI) return;
		stopTimer();
		const current = generation;
		generation = undefined;
		const message = event.message;
		const elapsed = current ? Math.max(0, performance.now() - current.startedAt) : 0;
		const tokens = current && current.estimatedTokens > 0 ? current.estimatedTokens : estimateMessage(message);
		const interrupted = message.stopReason === "aborted";
		const failed = message.stopReason === "error";
		const theme = ctx.ui.theme;
		const icon = theme.fg(failed ? "error" : interrupted ? "warning" : "success", failed ? "×" : interrupted ? "■" : "✓");
		const label = failed ? " error" : interrupted ? " stopped" : "";
		if (tokens <= 0) {
			ctx.ui.setStatus(STATUS_KEY, icon + theme.fg("dim", (label || " no output") + ` · ${formatDuration(elapsed)}`));
			return;
		}
		const outputElapsed = current?.firstOutputAt !== undefined && current.lastOutputAt !== undefined
			? current.lastOutputAt - current.firstOutputAt : 0;
		const rate = outputElapsed >= MIN_RATE_MS ? tokens * 1_000 / outputElapsed : undefined;
		const value = rate === undefined ? "—" : `≈${rate.toFixed(1)}`;
		ctx.ui.setStatus(STATUS_KEY,
			icon + theme.fg("dim", label) + " " + theme.fg("accent", theme.bold(value)) +
			theme.fg("dim", ` tok/s avg · ≈${formatTokens(tokens)} tok · ${formatDuration(elapsed)} total`));
	});

	pi.on("agent_end", (_event, ctx) => {
		stopTimer();
		agentRunning = false;
		if (generation && ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "■ no response"));
		}
		generation = undefined;
	});
}
