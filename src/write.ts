import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveFilePath, mutateFile, validateWritePath, validateWriteText, writeTextFile, type FileMutationOutcome } from "./file-contract.ts";

export default function write(pi: ExtensionAPI): void {
	const builtin = createWriteToolDefinition(process.cwd());
	pi.registerTool<typeof builtin.parameters, FileMutationOutcome>({
		...builtin,
		description: builtin.description + " Writes UTF-8 with exactly the supplied line endings; use edit to preserve surrounding text and existing line endings.",
		renderResult: builtin.renderResult && ((result, options, theme, ctx) =>
			builtin.renderResult!({ ...result, details: undefined }, options, theme, ctx)),
		async execute(_id, args, signal, _onUpdate, ctx) {
			const path = resolveFilePath(args.path, ctx.cwd);
			validateWritePath(path);
			validateWriteText(args.content);
			const existed = await mutateFile(path, async () => {
				signal?.throwIfAborted();
				await mkdir(dirname(path), { recursive: true });
				const exists = await stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
					return false;
				});
				signal?.throwIfAborted();
				await writeTextFile(path, args.content);
				return exists;
			});
			const crlf = args.content.includes("\r\n"), lf = /(?<!\r)\n/.test(args.content);
			const endings = crlf && lf ? ", mixed LF/CRLF" : crlf ? ", CRLF" : lf ? ", LF" : "";
			return { content: [{ type: "text", text: `${existed ? "Replaced" : "Created"} ${path} (${Buffer.byteLength(args.content, "utf8")} bytes, UTF-8${endings}).` }], details: { path, changed: true } };
		},
	});
}
