import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { createEditToolDefinition, generateDiffString, generateUnifiedPatch, type EditToolDetails, type EditToolInput, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeUtf8Text, mutateFile, resolveFilePath, validateWritePath, validateWriteText, writeTextFile, type FileMutationOutcome } from "./file-contract.ts";

export type Edit = EditToolInput["edits"][number];
const toLF = (text: string) => text.replace(/\r\n?/g, "\n");

function replaceExact(original: string, edits: Edit[], path: string): string {
	const normalized = toLF(original);
	if (!edits.length) throw new Error("Supply at least one replacement.");
	const matches = edits.map(({ oldText, newText }, i) => {
		const needle = toLF(oldText);
		if (!needle) throw new Error(`edits[${i}].oldText is empty.`);
		const start = normalized.indexOf(needle);
		if (start < 0) throw new Error(`No exact match for edits[${i}].oldText in ${path}. Read the file again and copy the current text including whitespace.`);
		if (normalized.indexOf(needle, start + 1) >= 0) throw new Error(`edits[${i}].oldText is not unique in ${path}. Include more surrounding context.`);
		return { start, end: start + needle.length, newText: toLF(newText) };
	}).sort((a, b) => a.start - b.start);

	// Only CRLF changes offsets. Follow the sorted edits once, preserving the original bytes between them.
	let extra = 0, nextCRLF = original.indexOf("\r\n");
	const rawOffset = (offset: number) => {
		while (nextCRLF >= 0 && nextCRLF - extra < offset) {
			extra++;
			nextCRLF = original.indexOf("\r\n", nextCRLF + 2);
		}
		return offset + extra;
	};
	const parts: string[] = [];
	const append = (part: string) => {
		if (!part) return;
		if (parts.at(-1)?.endsWith("\r") && part.startsWith("\n")) parts.push("\n");
		parts.push(part);
	};
	let cursor = 0, previousEnd = 0;
	for (const { start, end, newText } of matches) {
		if (start < previousEnd) throw new Error(`The replacements overlap in ${path}. Merge them into one edit.`);
		const from = rawOffset(start);
		append(original.slice(cursor, from));
		cursor = rawOffset(end);
		previousEnd = end;
		if (normalized.slice(start, end) === newText) {
			append(original.slice(from, cursor));
			continue;
		}
		let lf = original.indexOf("\n", from);
		if (lf < 0) lf = original.lastIndexOf("\n", from);
		const ending = lf < 0 && original.includes("\r") ? "\r" : original[lf - 1] === "\r" ? "\r\n" : "\n";
		append(newText.replaceAll("\n", ending));
	}
	append(original.slice(cursor));
	return parts.join("");
}

export default function edit(pi: ExtensionAPI): void {
	const builtin = createEditToolDefinition(process.cwd());
	pi.registerTool<typeof builtin.parameters, EditToolDetails & FileMutationOutcome>({
		...builtin,
		// Pi's speculative preview accepts fuzzy matches. Show the diff of the actual edit on completion.
		renderCall(args, theme, ctx) { return builtin.renderCall!(args, theme, { ...ctx, argsComplete: false }); },
		async execute(_id, { path, edits }, signal, _onUpdate, ctx) {
			const absolute = resolveFilePath(path, ctx.cwd);
			validateWritePath(absolute);
			for (const { oldText, newText } of edits) {
				validateWriteText(oldText);
				validateWriteText(newText);
			}
			const local = relative(ctx.cwd, absolute);
			if (isAbsolute(local) || local === ".." || local.startsWith("../") || local.startsWith("..\\")) path = absolute;
			else path = path.replace(/^@/, "");
			return mutateFile(absolute, async () => {
				signal?.throwIfAborted();
				const bytes = await readFile(absolute);
				let before: string, after: string;
				const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "\uFEFF" : "";
				try {
					before = decodeUtf8Text(bytes, path).slice(bom.length);
					after = replaceExact(before, edits, path);
				} catch (error) {
					throw new Error(`${(error as Error).message} This call made no changes.`, { cause: error });
				}
				if (after === before) return { content: [{ type: "text", text: `No write needed for ${path}.` }], details: { path, changed: false, diff: "", patch: "" } };
				const oldLF = toLF(before), newLF = toLF(after);
				const details = { ...generateDiffString(oldLF, newLF), patch: generateUnifiedPatch(path, oldLF, newLF), path, changed: true };
				signal?.throwIfAborted();
				await writeTextFile(absolute, bom + after);
				return { content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }], details };
			});
		},
	});
}
