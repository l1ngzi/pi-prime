import { truncateToVisualLines, type AgentToolResult, type KeybindingHints, type Theme, type ThemeBg, type ThemeColor, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { TerminalOutput } from "./runtime.ts";

const SESSION_COLORS: ThemeColor[] = ["mdLink", "accent", "syntaxFunction", "syntaxVariable", "syntaxString"];
type Tone = "pending" | "success" | "error";
const BACKGROUND: Record<Tone, ThemeBg> = { pending: "toolPendingBg", success: "toolSuccessBg", error: "toolErrorBg" };
interface Args { cmd?: string; workdir?: string; tty?: boolean; session_id?: number; chars?: string; interrupt?: boolean; yield_time_ms?: number }
interface Context extends Pick<KeybindingHints, "keyHint"> { state: { call?: Box; tone?: Tone }; args: Args | undefined; isError: boolean }

class Heading implements Component {
  constructor(private readonly left: string, private readonly right: string) {}
  render(width: number): string[] {
    const [first = "", ...rest] = this.left.split("\n");
    const gap = width - visibleWidth(first) - visibleWidth(this.right);
    const top = !this.right ? first : first + " ".repeat(Math.max(2, gap)) + this.right;
    return new Text([top, ...rest].join("\n"), 0, 0).render(width);
  }
  invalidate(): void {}
}

// Bound visual lines, including the hint: long single-line input and narrow panes stay compact.
class Preview implements Component {
  private cache?: { width: number; lines: string[] };
  constructor(private readonly text: string, private readonly limit: number, private readonly keep: "start" | "end", private readonly theme: Theme, private readonly keyHint: Context["keyHint"]) {}
  render(width: number): string[] {
    if (this.cache?.width !== width) {
      const { visualLines, skippedCount } = truncateToVisualLines(this.text, this.limit, width, 0, this.keep);
      const hint = truncateToWidth(this.theme.fg("dim", `${this.keep === "end" ? "↑" : "+"} ${skippedCount} ${this.keep === "end" ? "earlier" : "more"} lines, `) + this.keyHint("app.tools.expand", "to expand"), width);
      this.cache = { width, lines: !skippedCount ? visualLines : this.keep === "end" ? [hint, ...visualLines] : [...visualLines, hint] };
    }
    return this.cache.lines;
  }
  invalidate(): void { this.cache = undefined; }
}

const sessionColor = (id: number): ThemeColor => SESSION_COLORS[(id - 1) % SESSION_COLORS.length]!;
export const sessionTag = (theme: Theme, id: number | undefined) =>
  id === undefined ? theme.fg("dim", "#?") : theme.fg(sessionColor(id), theme.bold(`#${id}`));
const seconds = (value: number) => `${value.toFixed(1)}s`;

export function formatKeys(text: string, theme: Theme, inline = false): string {
  return text.split(/(\r\n|[\x00-\x1f\x7f-\x9f])/).map((part, i) => {
    if (!(i % 2)) return part ? theme.fg("text", part) : "";
    const newline = part === "\r\n" || part === "\r" || part === "\n";
    const label = newline ? "⏎" : part === "\t" ? "⇥" : part === "\x1b" ? "␛" : part === "\x7f" ? "⌫"
      : part.charCodeAt(0) < 32 ? `^${String.fromCharCode(part.charCodeAt(0) + 64)}`
      : `U+${part.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    return theme.inverse(` ${label} `) + (newline && !inline ? "\n" : "");
  }).join("").replace(/\n$/, "");
}

export function isOutput(details: unknown): details is TerminalOutput {
  return !!details && typeof details === "object" && typeof (details as TerminalOutput).wall_time_seconds === "number" && typeof (details as TerminalOutput).output === "string";
}

export function statusLine(output: TerminalOutput, theme: Theme): string {
  const status = output.session_id !== undefined ? theme.fg(sessionColor(output.session_id), `◐ #${output.session_id} running`)
    : output.termination_reason === "ctrl_c" ? theme.fg("warning", `■ terminated (Ctrl+C) · exit ${output.exit_code}`)
    : output.exit_code === 0 ? theme.fg("success", "✓ exit 0") : theme.fg("error", `✗ exit ${output.exit_code}`);
  let line = status + theme.fg("dim", ` · ${seconds(output.wall_time_seconds)}`);
  if (output.interrupt_sent && !output.termination_reason) line += theme.fg("dim", " · Ctrl+C sent");
  if (output.cancelled) line += theme.fg("dim", " · wait cancelled");
  if (output.truncated) line += theme.fg("dim", ` · truncated (~${(output.original_token_count / 1000).toFixed(1)}k tokens)`);
  if (output.full_output_path) line += theme.fg("dim", output.log_truncated ? " · partial log " : " · full log ") + theme.fg("muted", output.full_output_path);
  return line;
}

export function styleOutput(output: TerminalOutput, theme: Theme): string {
  const text = output.output.replace(/[ \t]+$/, "").replace(/\r?\n$/, "");
  if (!text.trim()) return "";
  return text.split("\n").map(line => line === "... output truncated ..."
    ? theme.fg("dim", "┄┄ output truncated ┄┄") : theme.fg("toolOutput", line)).join("\n");
}

function preview(text: string, theme: Theme, expanded: boolean, keyHint: Context["keyHint"], input = false): Component {
  return expanded ? new Text(text, 0, 0) : new Preview(text, input ? 4 : 12, input ? "start" : "end", theme, keyHint);
}

function call(heading: Component, theme: Theme, context: Context): Component {
  const box = new Box(1, 1, text => theme.bg(BACKGROUND[context.state.tone ?? "pending"], text));
  box.addChild(heading);
  context.state.call = box;
  return box;
}

function renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: Context, input = ""): Component {
  const output = result.details;
  context.state.tone = options.isPartial || (isOutput(output) && output.session_id !== undefined) ? "pending"
    : isOutput(output) && output.exit_code === 0 && !context.isError ? "success" : "error";
  const parts: Component[] = [];
  // Expandable input belongs in the result: HTML exports serialize the call only once.
  if (input) parts.push(preview(formatKeys(input, theme), theme, options.expanded, context.keyHint, true));
  if (isOutput(output)) {
    const styled = styleOutput(output, theme);
    if (styled) parts.push(preview(styled, theme, options.expanded, context.keyHint));
    parts.push(new Text(statusLine(output, theme), 0, 0));
  } else {
    const text = result.content.map(block => block.type === "text" ? block.text : "").join("\n").trim();
    if (text) parts.push(new Text(theme.fg("error", text), 0, 0));
  }
  const box = new Box(1, 0, text => theme.bg(BACKGROUND[context.state.tone!], text));
  parts.forEach((part, i) => {
    if (i) box.addChild(new Spacer(1));
    box.addChild(part);
  });
  box.addChild(new Spacer(1));
  return box;
}

export const execRenderers = {
  renderShell: "self" as const,
  renderCall(args: Args | undefined, theme: Theme, context: Context): Component {
    const cmd = args?.cmd || "...";
    const meta = [args?.workdir, args?.tty ? "TTY" : undefined].filter(Boolean).map(label => theme.fg("dim", label!)).join("  ");
    const prompt = process.platform === "win32" ? "PS> " : "$ ";
    const title = cmd.split("\n").map((line, i) => theme.fg("toolTitle", theme.bold(`${i ? "" : prompt}${line}`))).join("\n");
    return call(new Heading(title, meta), theme, context);
  },
  renderResult,
};

export const writeRenderers = {
  renderShell: "self" as const,
  renderCall(args: Args | undefined, theme: Theme, context: Context): Component {
    const action = args?.interrupt || args?.chars === "\x03" ? "interrupt" : args?.chars ? "send input" : "collect output";
    const wait = args?.yield_time_ms ? ` · up to ${seconds(args.yield_time_ms / 1000)}` : "";
    const title = sessionTag(theme, args?.session_id) + theme.fg("muted", ` ${args?.chars ? "›" : "⋯"} ${action}`) + theme.fg("dim", wait);
    return call(new Text(title, 0, 0), theme, context);
  },
  renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: Context): Component {
    const output = result.details;
    const input = context.args?.chars ?? "";
    if (!input && !options.isPartial && !context.isError && isOutput(output) && output.session_id !== undefined && !output.output.trim() && !output.interrupt_sent && !output.cancelled && !output.truncated && !output.full_output_path) {
      context.state.call?.clear();
      return new Text(sessionTag(theme, output.session_id) + theme.fg("dim", ` ⋯ no new output · ${seconds(output.wall_time_seconds)} · running`), 1, 0);
    }
    return renderResult(result, options, theme, context, input);
  },
};
