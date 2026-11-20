import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import write from "../src/write.ts";
import { validateWritePath } from "../src/file-contract.ts";

let tool!: ToolDefinition;
await write({ registerTool: definition => { tool = definition as ToolDefinition; } } as ExtensionAPI);

test("write receipts distinguish queued creation and replacement and retain requested bytes", async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-prime-write-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const ctx = { cwd } as ExtensionToolContext;
	const run = (path: string, content: string) => tool.execute("write-test", { path, content }, undefined, undefined, ctx);
	const [created, replaced] = await Promise.all([run("nested/file.txt", "中文\r\n"), run("nested/file.txt", "😀\n")]);
	assert.match(JSON.stringify(created.content), /Created.*UTF-8, CRLF/);
	assert.match(JSON.stringify(replaced.content), /Replaced.*UTF-8, LF/);
	assert.equal(await readFile(join(cwd, "nested/file.txt"), "utf8"), "😀\n");
	assert.doesNotMatch(JSON.stringify((await run("nested/file.txt", "again\n")).content), /CRLF/);
	for (const content of ["", "no newline"]) {
		const result = await run("nested/file.txt", content);
		assert.doesNotMatch(JSON.stringify(result.content), /LF/);
		assert.equal(await readFile(join(cwd, "nested/file.txt"), "utf8"), content);
	}
	assert.match(JSON.stringify((await run("nested/file.txt", "one\r\ntwo\n")).content), /mixed LF\/CRLF/);
	if (process.platform === "win32") {
		for (const path of ["bad/CON", "bad/a<b>.txt", "bad/NUL.txt", "bad/trailing. "]) await assert.rejects(run(path, "x"), /Unsupported Windows file name/);
		assert.deepEqual(await readdir(cwd), ["nested"]);
	}
});

test("Windows path checks cover normal, extended, device and alternate-stream names", () => {
	for (const path of ["C:\\file.txt", "\\\\server\\share\\中文.txt", "\\\\?\\C:\\file.txt", "\\\\?\\UNC\\server\\share\\file.txt"]) validateWritePath(path, true);
	for (const path of ["C:\\CON", "C:\\aux.txt", "C:\\file:stream", "C:\\a<b>", "C:\\trailing.", "C:\\LPT1"]) assert.throws(() => validateWritePath(path, true), /Unsupported Windows file name/);
	validateWritePath("/tmp/CON", false);
});

test("write rejects NUL before creating directories or overwriting a file", async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-prime-write-nul-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await fs.writeFile(join(cwd, "existing.txt"), "original");
	for (const path of ["new/file.txt", "existing.txt"]) {
		await assert.rejects(tool.execute("write", { path, content: "a\0b" }, undefined, undefined, { cwd } as ExtensionToolContext), /NUL/);
	}
	assert.deepEqual(await readdir(cwd), ["existing.txt"]);
	assert.equal(await readFile(join(cwd, "existing.txt"), "utf8"), "original");
});

test("first creation serializes case aliases on Windows", { skip: process.platform !== "win32" }, async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-prime-write-alias-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const writeFile = fs.writeFile;
	let release!: () => void, entered!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const firstEntered = new Promise<void>(resolve => { entered = resolve; });
	const write = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof writeFile>) => {
		if (args[1] === "first") { entered(); await gate; }
		await writeFile(...args);
	});
	syncBuiltinESMExports();
	const ctx = { cwd } as ExtensionToolContext;
	const first = tool.execute("first", { path: "New/Case.txt", content: "first" }, undefined, undefined, ctx);
	try {
		await firstEntered;
		const second = tool.execute("second", { path: "new/case.txt", content: "second" }, undefined, undefined, ctx);
		try {
			await new Promise(resolve => setTimeout(resolve, 40));
			assert.equal(write.mock.callCount(), 1);
		} finally { release(); await Promise.all([first, second]); }
		assert.equal(await readFile(join(cwd, "NEW/CASE.TXT"), "utf8"), "second");
	} finally { release(); write.mock.restore(); syncBuiltinESMExports(); }
});

test("write reports uncertain contents after a partial write and rejects malformed Unicode before changing the file", async t => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-prime-write-fault-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const ctx = { cwd } as ExtensionToolContext;
	const run = (content: string) => tool.execute("write-test", { path: "file.txt", content }, undefined, undefined, ctx);
	await run("before");
	await assert.rejects(run("\ud800"), /made no changes/);
	assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "before");
	const writeFile = fs.writeFile;
	const write = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof writeFile>) => {
		await writeFile(args[0], "partial", args[2]);
		throw new Error("simulated disk failure");
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(run("after"), /Read the file to check its current contents before retrying/);
		assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "partial");
	} finally { write.mock.restore(); syncBuiltinESMExports(); }
});
