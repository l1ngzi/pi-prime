import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tps from "../src/tps.ts";

function setup(t: TestContext) {
	let now = 0;
	let status: string | undefined;
	let tick = () => {};
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	t.mock.method(performance, "now", () => now);
	t.mock.method(globalThis, "setInterval", (callback: () => void) => { tick = callback; return { unref() {} }; });
	t.mock.method(globalThis, "clearInterval", () => {});
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (_key: string, value: string | undefined) => { status = value; },
			theme: { fg: (_color: string, value: string) => value, bold: (value: string) => value },
		},
	};
	tps({ on: (name, handler) => { handlers.set(name, handler); } } as ExtensionAPI);
	const emit = (at: number, name: string, event = {}) => {
		now = at;
		handlers.get(name)?.(event, ctx);
	};
	emit(0, "agent_start");
	emit(0, "turn_start");
	emit(0, "before_provider_request");
	t.after(() => handlers.get("session_shutdown")?.({}, ctx));
	return {
		emit, status: () => status,
		render: (at: number) => { now = at; tick(); },
		update: (at: number, message: any, delta: any) => emit(at, "message_update", { message, assistantMessageEvent: delta }),
	};
}

test("live and final rates estimate visible output, excluding initial wait and provider usage", t => {
	const { emit, update, render, status } = setup(t);
	const message = {
		role: "assistant", content: [{ type: "thinking", thinking: "abcd" }, { type: "text", text: "汉字" }],
		usage: { output: 500, reasoning: 400 }, stopReason: "stop",
	};
	emit(1000, "before_provider_request"); // A retry keeps the original request clock.
	emit(2000, "message_start", { message });
	update(2500, message, { type: "text_delta", delta: "" });
	render(7000);
	assert.equal(status(), "● waiting · 7.0s");
	update(8000, message, { type: "thinking_delta", delta: "abcd" });
	update(8500, message, { type: "text_delta", delta: "汉" });
	render(8500);
	assert.equal(status(), "● ≈4.0 tok/s · 8.5s");
	update(9000, message, { type: "text_delta", delta: "字" });
	emit(11000, "message_end", { message });
	assert.equal(status(), "✓ ≈3.0 tok/s avg · ≈3 tok · 11.0s total");
	emit(25000, "message_end", { message: { role: "toolResult" } });
	assert.equal(status(), "✓ ≈3.0 tok/s avg · ≈3 tok · 11.0s total");

	const toolMessage = {
		role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }],
		usage: { output: 60, reasoning: 0 }, stopReason: "toolUse",
	};
	emit(30000, "turn_start");
	emit(31000, "before_provider_request");
	emit(31500, "message_start", { message: toolMessage });
	update(32000, toolMessage, { type: "toolcall_start", contentIndex: 0 });
	update(34000, toolMessage, { type: "toolcall_delta", delta: '{"path":"file"}' });
	emit(35000, "message_end", { message: toolMessage });
	emit(45000, "agent_end");
	assert.equal(status(), "✓ ≈2.4 tok/s avg · ≈5 tok · 4.0s total");
});

test("brief output stays unmeasured while buffered spikes remain uncapped estimates", t => {
	const { emit, update, status } = setup(t);
	const message = {
		role: "assistant", content: [{ type: "text", text: "汉".repeat(1000) }],
		usage: { output: 692, reasoning: 321 }, stopReason: "stop",
	};
	for (const [gap, rate] of [[0, "—"], [40, "—"], [336.355, "≈2973.0"]] as const) {
		emit(0, "turn_start");
		emit(0, "before_provider_request");
		emit(2000, "message_start", { message });
		update(15000, message, { type: "text_delta", delta: "汉".repeat(500) });
		update(15000 + gap, message, { type: "text_delta", delta: "汉".repeat(500) });
		emit(16000, "message_end", { message });
		assert.equal(status(), `✓ ${rate} tok/s avg · ≈1.0k tok · 16.0s total`);
	}
});

test("final-only content retains its estimated count without inventing a streaming interval", t => {
	const { emit, status } = setup(t);
	const message = {
		role: "assistant", content: [{ type: "thinking", thinking: "abcdabcd" }, { type: "text", text: "汉字" }],
		usage: { output: 100 }, stopReason: "stop",
	};
	emit(2000, "message_start", { message });
	emit(10000, "message_end", { message });
	assert.equal(status(), "✓ — tok/s avg · ≈4 tok · 10.0s total");
});
