import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWriteToolDefinition, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import edit, { type Edit } from "../src/edit.ts";

let tool!: ToolDefinition;
await edit({ registerTool: definition => { tool = definition as ToolDefinition; } } as ExtensionAPI);

async function fixture(t: { after(fn: () => Promise<void>): void }, content: string) {
	const cwd = await mkdtemp(join(tmpdir(), "better-edit-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const path = join(cwd, "sample.txt");
	await writeFile(path, content);
	const ctx = { cwd } as ExtensionToolContext;
	return {
		path, ctx,
		run: (edits: Edit[], signal?: AbortSignal) => tool.execute("edit-test", { path: "@sample.txt", edits }, signal, undefined, ctx),
		read: () => readFile(path, "utf8"),
	};
}

test("exact edits distinguish full-width characters and preserve mixed line endings and the BOM", async t => {
	const f = await fixture(t, '\uFEFFＡ A it’s  \r\nold\r\nline\nlast\n');
	const result = await f.run([{ oldText: "Ａ", newText: "Ｂ" }, { oldText: "old\nline", newText: "new\nlines" }]);
	assert.equal(await f.read(), '\uFEFFＢ A it’s  \r\nnew\r\nlines\nlast\n');
	assert.equal((result.details as { firstChangedLine: number }).firstChangedLine, 1);
	assert.equal((result.details as { path: string }).path, "sample.txt");
	assert.match((result.content[0] as { text: string }).text, / in sample\.txt\./);
	assert.match((result.details as { patch: string }).patch, /Ｂ A it’s/);
	assert.doesNotMatch(JSON.stringify(tool.parameters), /allowFuzzy/);
});

test("an unchanged replacement spanning mixed line endings keeps its original bytes", async t => {
	const f = await fixture(t, "one\r\ntwo\nthree");
	const result = await f.run([{ oldText: "one\ntwo\nthree", newText: "one\ntwo\nthree" }]);
	assert.equal((result.details as { changed: boolean }).changed, false);
	assert.equal(await f.read(), "one\r\ntwo\nthree");
});

test("edits reject lossy encodings and binary files without changing any bytes", async t => {
	const f = await fixture(t, "");
	for (const before of [
		Buffer.concat([Buffer.from("d6d0cec4", "hex"), Buffer.from(" ASCII\r\n")]),
		Buffer.from("\uFEFFASCII 中文", "utf16le"),
		Buffer.from("ASCII\0binary"),
	]) {
		await writeFile(f.path, before);
		await assert.rejects(f.run([{ oldText: "ASCII", newText: "CHANGED" }]), /(?:UTF-8|NUL).*This call made no changes/s);
		assert.deepEqual(await readFile(f.path), before);
	}
	await writeFile(f.path, "\uFEFFASCII 中文😀 �\r\n");
	await f.run([{ oldText: "ASCII", newText: "CHANGED" }]);
	assert.equal(await f.read(), "\uFEFFCHANGED 中文😀 �\r\n");
});

test("invalid edits fail before any write, including overlapping exact occurrences and partial normalization", async t => {
	for (const [before, edits, error] of [
		["😀", [{ oldText: "\ud83d", newText: "x" }], /unpaired/],
		["😀", [{ oldText: "😀", newText: "\ude00" }], /unpaired/],
		["abc", [{ oldText: "a", newText: "A" }, { oldText: "b", newText: "B\0" }], /NUL/],
		["aaaa", [{ oldText: "aaa", newText: "x" }], /not unique/],
		["Ａ Ａ", [{ oldText: "A", newText: "x" }], /No exact match/],
		["ﬃ", [{ oldText: "fi", newText: "x" }], /No exact match/],
		["abc", [{ oldText: "abc", newText: "x" }, { oldText: "bc", newText: "y" }], /overlap/],
		["abc", [{ oldText: "a", newText: "x" }, { oldText: "missing", newText: "y" }], /No exact match/],
		["abc", [{ oldText: "", newText: "x" }], /empty/],
	] as const) {
		const f = await fixture(t, before);
		await assert.rejects(f.run([...edits]), (failure: Error) => {
			assert.match(failure.message, error);
			assert.match(failure.message, /This call made no changes/);
			return true;
		});
		assert.equal(await f.read(), before);
	}
});

test("edit reports a completed write even if cancellation arrives at the write boundary", async t => {
	const f = await fixture(t, "before\n");
	const signal = new AbortController();
	const original = fs.writeFile;
	const write = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof original>) => {
		await original(...args);
		signal.abort();
	});
	syncBuiltinESMExports();
	try {
		const result = await f.run([{ oldText: "before", newText: "after" }], signal.signal);
		assert.match((result.content[0] as { text: string }).text, /Successfully replaced/);
		assert.equal(await f.read(), "after\n");
		const noop = await f.run([{ oldText: "after", newText: "after" }]);
		assert.match((noop.content[0] as { text: string }).text, /No write needed/);
		assert.equal(write.mock.callCount(), 1);
	} finally {
		write.mock.restore();
		syncBuiltinESMExports();
	}
});

test("same-file calls share the built-in write queue and observe cancellation before writing", async t => {
	const f = await fixture(t, "a b c");
	await Promise.all([
		f.run([{ oldText: "a", newText: "A" }]),
		f.run([{ oldText: "b", newText: "B" }]),
	]);
	assert.equal(await f.read(), "A B c");
	// Invocation order is preserved in both directions with the built-in write.
	const writer = createWriteToolDefinition(f.ctx.cwd);
	await Promise.all([
		f.run([{ oldText: "A", newText: "edited" }]),
		writer.execute("write-test", { path: f.path, content: "A fresh" }, undefined, undefined, f.ctx),
	]);
	assert.equal(await f.read(), "A fresh");
	await Promise.all([
		writer.execute("write-test", { path: f.path, content: "fresh c" }, undefined, undefined, f.ctx),
		f.run([{ oldText: "fresh", newText: "updated" }]),
	]);
	assert.equal(await f.read(), "updated c");
	await assert.rejects(f.run([{ oldText: "updated", newText: "lost" }], AbortSignal.abort()), /aborted/);
	assert.equal(await f.read(), "updated c");
});

test("a partial write failure reports uncertain file state instead of promising no changes", async t => {
	const f = await fixture(t, "before\n");
	const original = fs.writeFile;
	const write = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof original>) => {
		await original(args[0], "partial\n", args[2]);
		throw new Error("simulated disk failure");
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(f.run([{ oldText: "before", newText: "after" }]), (failure: Error) => {
			assert.match(failure.message, /Read the file to check its current contents/);
			assert.doesNotMatch(failure.message, /made no changes/);
			return true;
		});
		assert.equal(await f.read(), "partial\n");
	} finally {
		write.mock.restore();
		syncBuiltinESMExports();
	}
});
