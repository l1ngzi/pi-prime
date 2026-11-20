// Head/tail retention follows OpenAI Codex b8dceb0d (Apache-2.0).
import { stripVTControlCharacters } from "node:util";

import { Type } from "typebox";

export const terminalOutputSchema = Type.Object({
  wall_time_seconds: Type.Number({ minimum: 0 }),
  output: Type.String(),
  session_id: Type.Optional(Type.Integer({ minimum: 1 })),
  exit_code: Type.Optional(Type.Integer()),
  original_token_count: Type.Integer({ minimum: 0 }),
  truncated: Type.Optional(Type.Boolean()),
  full_output_path: Type.Optional(Type.String()),
  log_truncated: Type.Optional(Type.Boolean({ description: "True when full_output_path is partial due to the log size cap or a write error." })),
  cancelled: Type.Optional(Type.Boolean()),
  interrupt_sent: Type.Optional(Type.Boolean()),
  termination_reason: Type.Optional(Type.Literal("ctrl_c")),
}, { additionalProperties: false });

export const MAX_OUTPUT_BYTES = 1024 * 1024;

function utf8(bytes: Buffer, trimStart: boolean, trimEnd: boolean): string {
  let start = 0;
  let end = bytes.length;
  if (trimStart) while (start < end && (bytes[start] & 0xc0) === 0x80) start++;
  if (trimEnd && end > start) {
    let lead = end - 1;
    while (lead > start && (bytes[lead] & 0xc0) === 0x80) lead--;
    const byte = bytes[lead];
    const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    if (lead + width > end) end = lead;
  }
  return bytes.subarray(start, end).toString("utf8");
}

export function plainText(text: string): string {
  // ConPTY also redraws via column-1 moves. Fold same-row updates while
  // preserving moves to other rows as log boundaries.
  text = text.replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g, "");
  // On ConPTY's initially cleared screen, row positioning preserves real leading blank lines.
  const initial = /^((?:\x1b\[[0-?]*[ -/]*[@-~])*)\x1b\[([1-9]\d?);1[Hf]/.exec(text);
  let output = initial?.[1].includes("\x1b[2J") ? "\n".repeat(Number(initial[2]) - 1) : "";
  let row: number | undefined;
  let outputRow: number | undefined;
  let moved = false;
  for (const [index, part] of text.split(/(\x1b\[(?:\d*(?:;1?)?[Hf]|1?G))/g).entries()) {
    if (index % 2) {
      if (!part.endsWith("G")) row = Number.parseInt(part.slice(2), 10) || 1;
      moved = true;
      continue;
    }
    const plain = stripVTControlCharacters(part).replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    if (!plain) continue;
    if (moved && output && !output.endsWith("\n") && !plain.startsWith("\n")) output += row === outputRow ? "\r" : "\n";
    output += plain;
    if (row !== undefined) row += plain.split("\n").length - 1;
    outputRow = row;
    moved = false;
  }
  return output.split("\n").map(line => {
    // CR redraws replace the line; a trailing CR awaits the next write.
    line = line.replace(/\r+$/, "");
    return line.slice(line.lastIndexOf("\r") + 1);
  }).join("\n");
}

export class OutputBuffer {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  omittedBytes = 0;
  originalBytes = 0;

  constructor(readonly maxBytes: number) {}

  append(bytes: Buffer): void {
    const headBudget = Math.floor(this.maxBytes / 2);
    const fill = Math.min(bytes.length, headBudget - this.head.length);
    if (fill) this.head = Buffer.concat([this.head, bytes.subarray(0, fill)]);
    bytes = bytes.subarray(fill);
    const tailBudget = this.maxBytes - headBudget;
    if (bytes.length >= tailBudget) {
      this.omittedBytes += this.tail.length + bytes.length - tailBudget;
      this.tail = Buffer.from(bytes.subarray(bytes.length - tailBudget));
    } else if (bytes.length) {
      const excess = Math.max(0, this.tail.length + bytes.length - tailBudget);
      this.omittedBytes += excess;
      this.tail = Buffer.concat([this.tail, bytes]).subarray(excess);
    }
  }

  get retainedBytes(): number {
    return this.head.length + this.tail.length;
  }

  get truncated(): boolean {
    return this.omittedBytes > 0;
  }

  get text(): string {
    if (this.maxBytes === 0) return "";
    if (!this.truncated) return plainText(Buffer.concat([this.head, this.tail]).toString("utf8"));
    let head = plainText(utf8(this.head, false, true));
    let tail = plainText(utf8(this.tail, true, false));
    const headBreak = head.lastIndexOf("\n");
    const tailBreak = tail.indexOf("\n");
    if (headBreak >= 0) head = head.slice(0, headBreak + 1);
    if (tailBreak >= 0) tail = tail.slice(tailBreak + 1);
    return `${head}${head && !head.endsWith("\n") ? "\n" : ""}... output truncated ...\n${tail}`;
  }
}
