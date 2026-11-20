import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execRenderers, writeRenderers } from "../src/terminal/render.ts";
import type { TerminalOutput } from "../src/terminal/runtime.ts";

const { createToolHtmlRenderer } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js", import.meta.url).href);
const themeModule = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js", import.meta.url).href);
initTheme("dark", false);

function component(name: "exec_command" | "write_stdin", args: Record<string, unknown>) {
  const tool = {
    name, label: name, description: name, parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
    ...(name === "exec_command" ? execRenderers : writeRenderers),
  } as unknown as ConstructorParameters<typeof ToolExecutionComponent>[4];
  const ui = { requestRender() {} } as ConstructorParameters<typeof ToolExecutionComponent>[5];
  return new ToolExecutionComponent(name, "test", args, undefined, tool, ui, process.cwd());
}
const plain = (view: ToolExecutionComponent, width = 80) => view.render(width).map(stripVTControlCharacters).join("\n");
const background = (view: ToolExecutionComponent) => view.render(80).map(line => line.match(/\x1b\[48;[0-9;]*m/)?.[0]).find(Boolean);
const done = (fields: Partial<TerminalOutput>) => {
  const details = { wall_time_seconds: 1, output: "", original_token_count: 0, ...fields };
  return { content: [{ type: "text" as const, text: "MODEL_FALLBACK" }], details, isError: details.exit_code !== undefined && details.exit_code !== 0 };
};

function fits(view: ToolExecutionComponent) {
  for (const width of [20, 30, 80]) for (const line of view.render(width)) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${stripVTControlCharacters(line)}`);
  }
}

test("terminal cards keep live sessions neutral and bound output tails and hints", () => {
  const view = component("exec_command", { cmd: 'Get-Location\n"中文 😀"', workdir: "C:/with space", tty: true });
  const pending = background(view);
  assert.ok(pending);
  assert.match(plain(view), process.platform === "win32" ? /PS> Get-Location +C:\/with space  TTY/ : /\$ Get-Location +C:\/with space  TTY/);
  view.updateResult(done({ session_id: 3, output: "password: " }), true);
  assert.ok(plain(view).includes("password:"));
  view.updateResult(done({ session_id: 3 }));
  assert.equal(background(view), pending);
  assert.ok(plain(view).includes("◐ #3 running · 1.0s"));
  view.updateResult(done({ exit_code: 0 }));
  const success = background(view);
  assert.ok(success && success !== pending);
  assert.ok(plain(view).includes("✓ exit 0"));

  view.updateResult(done({ exit_code: 1, truncated: true, original_token_count: 18_240, full_output_path: "C:/logs/session.log",
    output: ["line-00", "... output truncated ...", ...Array.from({ length: 40 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`)].join("\n") }));
  const text = plain(view);
  assert.ok(text.includes("line-29") && text.includes("line-40") && !text.includes("line-28"), text);
  assert.match(text, /↑ 30 earlier lines, .*to expand/);
  assert.ok(text.includes("truncated (~18.2k tokens) · full log C:/logs/session.log"));
  assert.ok(!text.includes("MODEL_FALLBACK"));
  const error = background(view);
  assert.ok(error && error !== pending && error !== success);
  fits(view);
  view.setExpanded(true);
  assert.ok(plain(view).includes("line-00") && plain(view).includes("┄┄ output truncated ┄┄"));
  view.updateResult(done({ exit_code: 1, termination_reason: "ctrl_c" }));
  assert.ok(plain(view).includes("terminated (Ctrl+C) · exit 1"));
  assert.ok(!plain(view).includes("wait cancelled"));
  view.updateResult(done({ session_id: 3, interrupt_sent: true }));
  assert.match(plain(view), /#3 running.*Ctrl\+C sent/);
  view.updateResult(done({ exit_code: 1, interrupt_sent: true }));
  assert.match(plain(view), /exit 1.*Ctrl\+C sent/);
  fits(view);

  const thrown = component("write_stdin", { session_id: 9 });
  thrown.updateResult({ content: [{ type: "text", text: "unknown session_id: 9" }], details: undefined, isError: true });
  assert.ok(plain(thrown).includes("unknown session_id: 9"));
  assert.equal(background(thrown), error);
});

test("stdin previews bound wrapped input, escape control keys, and expand fully in HTML", () => {
  const chars = "one\ntwo\nthree\nfour\nFIFTH_UNIQUE_LINE\nsix\t\x03\x1b[A\x9b[A\n";
  const view = component("write_stdin", { session_id: 3, chars });
  view.updateResult(done({ session_id: 3, output: "REMOTE_READY" }));
  assert.ok(plain(view).includes("one ⏎") && plain(view).includes("+ 2 more lines"));
  assert.ok(!plain(view).includes("FIFTH_UNIQUE_LINE"));
  view.setExpanded(true);
  const text = plain(view);
  assert.ok(text.includes("FIFTH_UNIQUE_LINE") && text.includes("⇥") && text.includes("^C") && text.includes("␛") && text.includes("U+009B"));
  const raw = view.render(80).join("");
  assert.ok(!raw.includes("\x03") && !raw.includes("\x1b[A") && !raw.includes("\x9b"));

  const long = component("write_stdin", { session_id: 3, chars: "x".repeat(10_000) + "中文😀\n" });
  long.updateResult(done({ session_id: 3 }));
  assert.ok(long.render(80).length <= 13, "collapsed input is bounded by visual, not logical, lines");
  fits(long);
  long.setExpanded(true);
  assert.ok(long.render(80).length > 100);

  const html = createToolHtmlRenderer({ getToolRenderers: () => writeRenderers, theme: themeModule.theme, cwd: process.cwd() });
  assert.ok(html.renderCall("write", "write_stdin", { session_id: 3, chars }));
  const result = done({ exit_code: 0, output: "REMOTE_READY" });
  const rendered = html.renderResult("write", "write_stdin", result.content, result.details, false);
  assert.ok(rendered?.collapsed && rendered.expanded);
  assert.ok(!rendered.collapsed.includes("FIFTH_UNIQUE_LINE"));
  assert.ok(rendered.expanded.includes("FIFTH_UNIQUE_LINE") && rendered.expanded.includes("REMOTE_READY"));
  assert.ok(!rendered.expanded.includes("MODEL_FALLBACK"));
});

test("only ordinary empty polls collapse; cancellation and log paths remain visible", () => {
  const view = component("write_stdin", { session_id: 3, yield_time_ms: 3000 });
  assert.ok(plain(view).includes("#3 ⋯ collect output · up to 3.0s"));
  view.updateResult(done({ session_id: 3 }));
  assert.deepEqual(view.render(80).map(stripVTControlCharacters).map(line => line.trimEnd()), ["", " #3 ⋯ no new output · 1.0s · running"]);
  assert.equal(background(view), undefined);
  const interrupt = component("write_stdin", { session_id: 3, interrupt: true });
  interrupt.updateResult(done({ session_id: 3, interrupt_sent: true }));
  assert.match(plain(interrupt), /Ctrl\+C sent/);
  view.updateResult(done({ session_id: 3, cancelled: true }));
  assert.ok(plain(view).includes("wait cancelled") && !plain(view).includes("no new output"));
  view.updateResult(done({ session_id: 3, truncated: true, original_token_count: 42, full_output_path: "C:/logs/full.log" }));
  assert.ok(plain(view).includes("full log C:/logs/full.log") && !plain(view).includes("no new output"));
  view.setExpanded(true);
  assert.ok(plain(view).includes("full log C:/logs/full.log"));
  view.updateResult(done({ exit_code: 0, full_output_path: "C:/logs/full.log" }));
  assert.ok(plain(view).includes("full log C:/logs/full.log"), "completed sessions retain their saved log path");
});
