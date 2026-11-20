import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { access, open, readFile } from "node:fs/promises";
import { createReadToolDefinition, detectSupportedImageMimeTypeFromFile, DEFAULT_MAX_BYTES, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasUtf16Bom } from "./file-contract.ts";

export default function read(pi: ExtensionAPI): void {
	const builtin = createReadToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		description: builtin.description + " Text is decoded as UTF-8; invalid bytes are shown as � with a notice.",
		parameters: Type.Object({
			...builtin.parameters.properties,
			offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line to read (1-indexed)." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read." })),
		}),
		async execute(id, args, signal, onUpdate, ctx) {
			let bytes = 0, newlines = 0, last = -1, isTextFile = false;
			let hasUnscannedLines = false;
			const line = args.offset ?? 1, endLine = line + (args.limit ?? Infinity);
			const totalLines = () => newlines + Number(bytes > 0 && last !== 10);
			// Keep a bounded raw sample of the requested range to check the text Pi actually returns.
			const sample: Buffer[] = [];
			let sampleBytes = 0;
			function scanText(path: string, chunk: Buffer) {
				if (bytes === 0 && hasUtf16Bom(chunk)) throw new Error(`${path} is UTF-16 text. Use exec_command with UTF-16 encoding to read it.`);
				bytes += chunk.length;
				for (let start = 0; start < chunk.length;) {
					const newline = chunk.indexOf(10, start), stop = newline < 0 ? chunk.length : newline + 1;
					if (newlines + 1 >= line && newlines + 1 < endLine && sampleBytes < DEFAULT_MAX_BYTES + 1) {
						const part = chunk.subarray(start, Math.min(stop, start + DEFAULT_MAX_BYTES + 1 - sampleBytes));
						sample.push(part);
						sampleBytes += part.length;
					}
					if (newline >= 0) newlines++;
					start = stop;
				}
				if (chunk.length) last = chunk[chunk.length - 1];
			}
			function checkOffset() {
				if (line > Math.max(1, totalLines())) throw new Error(`Offset ${line} is beyond end of file (${totalLines()} lines total).`);
			}
			const tool = createReadToolDefinition(ctx.cwd, { autoResizeImages: pi.getSettings().images?.autoResize, operations: {
				access: path => access(path, constants.R_OK),
				async detectImageMimeType(path) {
					const mime = await detectSupportedImageMimeTypeFromFile(path);
					isTextFile = !mime;
					return mime;
				},
				async readFile(path) {
					const buffer = await readFile(path);
					if (isTextFile) {
						scanText(path, buffer);
						checkOffset();
					}
					return buffer;
				},
				async *createReadStream(path, { signal }) {
					const handle = await open(path, "r");
					try {
						const stats = await handle.stat();
						const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
						for await (const chunk of handle.createReadStream({ end, signal, autoClose: false })) {
							scanText(path, chunk);
							yield chunk;
							// An explicit window needs a continuation offset, not an exact
							// count of the rest of a large file.
							if (args.limit !== undefined && newlines >= endLine - 1 && end !== undefined && bytes <= end) {
								hasUnscannedLines = true;
								break;
							}
						}
						checkOffset();
					} finally { await handle.close(); }
				},
			} });
			const result = await tool.execute(id, args, signal, onUpdate, ctx);
			if (!isTextFile) return result;
			if (!bytes) return { ...result, content: [{ type: "text", text: "[Empty file: 0 bytes]" }], structuredContent: "" };
			const truncation = result.details?.truncation;
			const shownLines = truncation?.firstLineExceedsLimit ? 1 : truncation?.outputLines ?? Math.min(args.limit ?? Infinity, totalLines() - line + 1);
			const raw = Buffer.concat(sample);
			let end = 0;
			for (let count = 0; count < shownLines && end < raw.length; count++) {
				const newline = raw.indexOf(10, end);
				end = newline < 0 ? raw.length : newline + 1;
			}
			const visible = raw.subarray(0, end);
			if (visible.includes(0)) throw new Error("The requested text contains NUL bytes (binary data or a non-UTF-8 encoding). Use exec_command with an explicit encoding or a binary reader.");
			let text = result.structuredContent as string;
			if (truncation?.firstLineExceedsLimit) {
				text = `Line ${line} exceeds the ${truncation.maxBytes}-byte read limit. Use exec_command to select this line and print a bounded character or byte range.`;
			} else if (truncation?.truncated) {
				const next = line + truncation.outputLines;
				const total = hasUnscannedLines ? "" : ` of ${totalLines()}`;
				const cap = truncation.truncatedBy === "bytes" ? ` (${truncation.maxBytes / 1024}KB limit)` : "";
				text = `${truncation.content}\n\n[Showing lines ${line}-${next - 1}${total}${cap}. Use offset=${next} to continue.]`;
			} else if (args.limit !== undefined) {
				const next = endLine;
				text = (newlines >= next - 1 ? raw.subarray(0, -1) : raw).toString("utf8");
				const actualRemaining = totalLines() + 1 - next;
				if (hasUnscannedLines) text += `\n\n[More lines in file. Use offset=${next} to continue.]`;
				else if (actualRemaining > 0) text += `\n\n[${actualRemaining} more lines in file. Use offset=${next} to continue.]`;
			}
			if (!truncation?.firstLineExceedsLimit && !isUtf8(visible)) text += "\n\n[Encoding notice: Invalid UTF-8 bytes in these lines are shown as �. Use exec_command with the source encoding for exact text.]";
			return { ...result, content: [{ type: "text", text }], structuredContent: text };
		},
	});
}
