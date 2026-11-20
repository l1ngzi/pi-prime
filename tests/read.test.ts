import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import * as sdk from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, type ExtensionAPI, type ExtensionToolContext, type ReadToolInput, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import read from "../src/read.ts";

let tool!: ToolDefinition;
const api = { getSettings: () => ({}), registerTool: definition => { tool = definition as ToolDefinition; } } as ExtensionAPI;
await read(api);

async function execute(args: ReadToolInput, ctx: ExtensionToolContext, signal?: AbortSignal) {
	return tool.execute("read-test", args, signal, undefined, ctx);
}

test("Pi 1.5.0 buffered reads validate only visible text and preserve binary images", async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-prime-buffered-read-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const buffered: typeof createReadToolDefinition = (cwd, options) => createReadToolDefinition(cwd, {
		...options, operations: options?.operations && { ...options.operations, createReadStream: undefined },
	});
	const jiti = createJiti(import.meta.url, { tryNative: false, moduleCache: false, virtualModules: {
		"@earendil-works/pi-coding-agent": { ...sdk, createReadToolDefinition: buffered },
	} });
	const register = await jiti.import<typeof read>(new URL("../src/read.ts", import.meta.url).href, { default: true });
	let legacy!: ToolDefinition;
	register({ ...api, getSettings: () => ({ images: { autoResize: false } }), registerTool: definition => { legacy = definition as ToolDefinition; } });
	const run = (args: ReadToolInput) => legacy.execute("buffered", args, undefined, undefined, { cwd } as ExtensionToolContext);
	const path = join(cwd, "data");
	for (const bom of ["fffe", "feff"]) {
		await writeFile(path, Buffer.from(bom + "0061", "hex"));
		await assert.rejects(run({ path }), /UTF-16/);
	}
	await writeFile(path, Buffer.from([0x61, 10, 0xff, 10, 0, 10]));
	assert.doesNotMatch((await run({ path, limit: 1 })).structuredContent as string, /Encoding notice|�/);
	assert.match((await run({ path, offset: 2, limit: 1 })).structuredContent as string, /^�.*Encoding notice/s);
	await assert.rejects(run({ path, offset: 3, limit: 1 }), /NUL/);
	const png = "iVBORw0KGgoAAAANSUhEUgAAEAAAAAABCAAAAAB7SjSgAAAAGklEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAHBvEAEAAWmM9GMAAAAASUVORK5CYII=";
	await writeFile(path, Buffer.from(png, "base64"));
	assert.equal((await run({ path })).content.find(part => part.type === "image")?.data, png);
});

test("read pagination preserves notice-like source lines and supports early windows", async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-prime-read-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const ctx = { cwd } as ExtensionToolContext;
	const fakeFooter = "[Showing lines 100-101 of 999. Use offset=102 to continue.]";
	await writeFile(join(cwd, "text.txt"), fakeFooter + "\n" + "正文\n".repeat(2400));
	const full = await execute({ path: "text.txt" }, ctx);
	const text = full.structuredContent as string;
	assert.equal(text.split("\n")[0], fakeFooter);
	assert.match(text, /\[Showing lines 1-2000 of 2401\. Use offset=2001 to continue\.\]$/);
	await writeFile(join(cwd, "large.txt"), fakeFooter + "\nsecond\n" + "界".repeat(100_000));
	const window = await execute({ path: "large.txt", limit: 2 }, ctx);
	assert.equal(window.structuredContent, fakeFooter + "\nsecond\n\n[More lines in file. Use offset=3 to continue.]");
	const exactPage = "a".repeat(50 * 1024);
	await writeFile(join(cwd, "exact.txt"), exactPage + "\nlast");
	assert.equal((await execute({ path: "exact.txt", limit: 1 }, ctx)).structuredContent, exactPage + "\n\n[1 more lines in file. Use offset=2 to continue.]");
	assert.equal((await execute({ path: "exact.txt", offset: 2, limit: 1 }, ctx)).structuredContent, "last");
});

test("long lines give a shell-independent paging hint", async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-prime-read-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "长行.txt"), "first\n" + "😀中a".repeat(18_000) + "\nlast");
	const result = await execute({ path: "@长行.txt", offset: 2, limit: 1 }, { cwd } as ExtensionToolContext);
	assert.match(result.structuredContent as string, /Line 2.*limit.*exec_command.*range/);
	assert.doesNotMatch(result.structuredContent as string, /node -e|sed -n/);
});

test("ordinary text, line paging and images retain native read results", async t => {
	const directory = await mkdtemp(join(tmpdir(), "pi-prime-read-"));
	t.after(() => {
		assert.ok(directory.startsWith(join(tmpdir(), "pi-prime-read-")));
		return rm(directory, { recursive: true, force: true });
	});
	const ctx = { cwd: directory } as ExtensionToolContext;
	const builtin = createReadToolDefinition(directory);
	await writeFile(join(directory, "text.txt"), "first\r\nsecond\r\nthird\n");
	await writeFile(join(directory, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l0AAAAASUVORK5CYII=", "base64"));
	for (const args of [{ path: "text.txt" }, { path: "image.png" }]) {
		assert.deepEqual(await execute(args, ctx),
			await builtin.execute("read-native", args, undefined, undefined, ctx));
	}
	// A valid 4096-pixel-wide grayscale PNG exceeds Pi's default resizing threshold.
	const wide = "iVBORw0KGgoAAAANSUhEUgAAEAAAAAABCAAAAAB7SjSgAAAAGklEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAHBvEAEAAWmM9GMAAAAASUVORK5CYII=";
	await writeFile(join(directory, "wide.png"), Buffer.from(wide, "base64"));
	t.mock.method(api, "getSettings", () => ({ images: { autoResize: false } }));
	assert.equal((await execute({ path: "wide.png" }, ctx)).content.find(part => part.type === "image")?.data, wide);
	const aborted = AbortSignal.abort();
	await assert.rejects(execute({ path: "text.txt" }, ctx, aborted), /aborted/i);
	await assert.rejects(execute({ path: "missing.txt" }, ctx), /ENOENT/);
});

test("read reports lossy UTF-8 only in returned lines and keeps binary output concise", async t => {
	const directory = await mkdtemp(join(tmpdir(), "pi-prime-read-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const ctx = { cwd: directory } as ExtensionToolContext;
	for (const bytes of [Buffer.from("fffe6100", "hex"), Buffer.from("a\0b")]) {
		await writeFile(join(directory, "bad.txt"), bytes);
		await assert.rejects(execute({ path: "bad.txt", limit: 1 }, ctx), /UTF-16|NUL/);
	}
	await writeFile(join(directory, "bad.txt"), Buffer.from("\uFEFFtext", "utf16le"));
	await assert.rejects(execute({ path: "bad.txt" }, ctx), /is UTF-16 text/);
	await writeFile(join(directory, "good.txt"), "a".repeat(65535) + "😀\n中文\n");
	assert.equal((await execute({ path: "good.txt", offset: 2 }, ctx)).structuredContent, "中文\n");
	await writeFile(join(directory, "good.txt"), "valid replacement character: �\n");
	assert.equal((await execute({ path: "good.txt" }, ctx)).structuredContent, "valid replacement character: �\n");
	await writeFile(join(directory, "mixed.txt"), Buffer.concat([
		Buffer.from("first\nsecond\n" + "ascii\n".repeat(24000)), Buffer.from("d6d0cec4", "hex"), Buffer.from(" ASCII\nlast\n"),
	]));
	const first = (await execute({ path: "mixed.txt", limit: 2 }, ctx)).structuredContent as string;
	assert.match(first, /^first\nsecond\n/);
	assert.doesNotMatch(first, /Encoding notice|�/);
	const bad = (await execute({ path: "mixed.txt", offset: 24003, limit: 1 }, ctx)).structuredContent as string;
	assert.match(bad, /�.* ASCII/);
	assert.match(bad, /Encoding notice: Invalid UTF-8 bytes in these lines/);
	assert.equal((await execute({ path: "mixed.txt", offset: 24004 }, ctx)).structuredContent, "last\n");
	const truncated = (await execute({ path: "mixed.txt" }, ctx)).structuredContent as string;
	assert.doesNotMatch(truncated, /Encoding notice|�/);
	await writeFile(join(directory, "boundary.txt"), Buffer.concat([Buffer.alloc(65534, 65), Buffer.from("\n"), Buffer.from([0xe4, 0xb8])]));
	assert.match((await execute({ path: "boundary.txt", offset: 2 }, ctx)).structuredContent as string, /^�\n\n\[Encoding notice:/);
	await writeFile(join(directory, "binary-tail.txt"), "first\nsecond\n\0binary");
	assert.doesNotMatch((await execute({ path: "binary-tail.txt", limit: 2 }, ctx)).structuredContent as string, /binary|NUL/);
});

test("read distinguishes empty files, validates paging and counts a final newline consistently", async t => {
	const directory = await mkdtemp(join(tmpdir(), "pi-prime-read-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const ctx = { cwd: directory } as ExtensionToolContext;
	await writeFile(join(directory, "text.txt"), "first\r\nsecond\r\nthird\n");
	assert.equal((await execute({ path: "text.txt", offset: 2, limit: 1 }, ctx)).structuredContent, "second\r\n\n[1 more lines in file. Use offset=3 to continue.]");
	assert.equal((await execute({ path: "text.txt", offset: 3, limit: 1 }, ctx)).structuredContent, "third");
	await assert.rejects(execute({ path: "text.txt", offset: 4 }, ctx), /3 lines total/);
	await writeFile(join(directory, "many.txt"), "line\n".repeat(3000));
	assert.match((await execute({ path: "many.txt" }, ctx)).structuredContent as string, /\[Showing lines 1-2000 of 3000\./);
	for (const args of [{ offset: -5 }, { offset: 0 }, { offset: 1.5 }, { limit: 0 }, { limit: -1 }]) {
		assert.equal(Check(tool.parameters, { path: "text.txt", ...args }), false);
	}
	await writeFile(join(directory, "empty.txt"), "");
	const empty = await execute({ path: "empty.txt" }, ctx);
	assert.equal(empty.structuredContent, "");
	assert.deepEqual(empty.content, [{ type: "text", text: "[Empty file: 0 bytes]" }]);
	await writeFile(join(directory, "dots.txt"), "...");
	assert.equal((await execute({ path: "dots.txt" }, ctx)).structuredContent, "...");
});
