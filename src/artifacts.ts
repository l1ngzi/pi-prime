import { mkdirSync, mkdtempSync } from "node:fs";
import { readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Evaluation runners and power users can override where retained tool outputs are stored.
const defaultRoot = typeof process.getuid === "function" ? `pi-prime-artifacts-${process.getuid()}` : "pi-prime-artifacts";
export const artifactsRoot = resolve(process.env.PI_PRIME_ARTIFACTS_DIR || join(tmpdir(), defaultRoot));
const root = artifactsRoot;
const RETENTION_MS = 14 * 24 * 60 * 60_000;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
let lastSweep = 0;

async function latestMtime(directory: string): Promise<number> {
	let latest = (await stat(directory)).mtimeMs;
	for (const item of await readdir(directory)) {
		try { latest = Math.max(latest, (await stat(join(directory, item))).mtimeMs); }
		catch { /* Concurrent cleanup may remove individual files. */ }
	}
	return latest;
}

async function reap(directory: string, now: number) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const match = /^(terminal|codemode)-(\d+)-[\da-zA-Z]{6}$/.exec(entry.name);
		if (!entry.isDirectory() || !match) continue;
		const path = join(directory, entry.name);
		try {
			if (match[1] === "terminal") {
				try { process.kill(Number(match[2]), 0); continue; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
			}
			const resolved = await realpath(path);
			if (dirname(resolved) !== directory || resolved !== path) continue;
			if ((await latestMtime(path)) < now - RETENTION_MS) await rm(path, { force: true, recursive: true });
		} catch { /* An artifact may already have been removed. */ }
	}
}

export function artifactDirectory(kind: "terminal" | "codemode"): string {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const directory = mkdtempSync(join(root, `${kind}-${process.pid}-`));
	const now = Date.now();
	if (now - lastSweep > 60 * 60_000) {
		lastSweep = now;
		void realpath(root).then(path => reap(path, now)).catch(() => {});
	}
	return directory;
}

export async function archiveText(kind: "codemode", filename: string, text: string) {
	const bytes = Buffer.from(text);
	const truncated = bytes.length > MAX_TEXT_BYTES;
	let body = text;
	if (truncated) {
		let end = MAX_TEXT_BYTES / 2;
		let start = bytes.length - end;
		while ((bytes[end] & 0xc0) === 0x80) end--;
		while ((bytes[start] & 0xc0) === 0x80) start++;
		body = bytes.subarray(0, end).toString("utf8") + "\n\n[Archive size limit reached; middle omitted.]\n\n" + bytes.subarray(start).toString("utf8");
	}
	const path = join(artifactDirectory(kind), filename);
	await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
	return { path, truncated };
}
