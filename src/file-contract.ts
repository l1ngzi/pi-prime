import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Paths accepted by Pi file tools, including @paths and Windows shell drive paths. */
export function resolveFilePath(input: string, cwd: string): string {
	let path = input.replace(/^@/, "").replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
	if (process.platform === "win32" && !path.includes("\\")) {
		path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/|$)/i, "$1:/");
	}
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
	return resolve(cwd, path.startsWith("file://") ? fileURLToPath(path) : path);
}

const windowsMutations = new Map<string, Promise<void>>();

export function mutateFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
	if (process.platform !== "win32") return withFileMutationQueue(path, operation);
	// Pi resolves existing files. A case-folded absolute path also covers first creation.
	const key = path.toUpperCase();
	const previous = windowsMutations.get(key);
	const result = withFileMutationQueue(path, async () => {
		await previous;
		return operation();
	});
	const settled = result.then(() => {}, () => {});
	windowsMutations.set(key, settled);
	void settled.then(() => {
		if (windowsMutations.get(key) === settled) windowsMutations.delete(key);
	});
	return result;
}

export type FileMutationOutcome = { path: string; changed: boolean };

export function validateWriteText(text: string): void {
	if (text.includes("\0")) throw new Error("Supply text without NUL bytes. This call made no changes.");
	if (/[\uD800-\uDFFF]/u.test(text)) throw new Error("Supply well-formed text with no unpaired UTF-16 surrogates. This call made no changes.");
}

export async function writeTextFile(path: string, content: string): Promise<void> {
	try {
		await writeFile(path, content, "utf8");
	} catch (error) {
		throw new Error(`Could not finish writing ${path}: ${error instanceof Error ? error.message : String(error)}. Read the file to check its current contents before retrying.`, { cause: error });
	}
}

/** Decode text losslessly, preserving a UTF-8 BOM for the caller. */
export function decodeUtf8Text(bytes: Uint8Array, path: string): string {
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
	catch {
		throw new Error(hasUtf16Bom(bytes)
			? `${path} is UTF-16 text; edit requires UTF-8. Use exec_command with UTF-16 encoding to edit it.`
			: `${path} is not valid UTF-8 text. Use exec_command with an explicit source encoding to inspect or convert it.`);
	}
	if (text.includes("\0")) throw new Error(`${path} contains NUL bytes (binary data or a non-UTF-8 encoding). Use exec_command with an explicit encoding or a binary reader.`);
	return text;
}

/** Reject names Win32 tools cannot reliably address, before creating parent directories. */
export function validateWritePath(path: string, windows = process.platform === "win32"): void {
	if (!windows) return;
	const local = path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
	for (const [index, part] of local.split(/[\\/]/).filter(Boolean).entries()) {
		if (index === 0 && /^[a-z]:$/i.test(part)) continue;
		if (/[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part)
			|| /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
			throw new Error(`Unsupported Windows file name ${JSON.stringify(part)} in ${path}. Use a name without reserved device names, forbidden characters, or trailing dots/spaces. This call made no changes.`);
		}
	}
}

export function hasUtf16Bom(bytes: Uint8Array): boolean {
	return (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}
