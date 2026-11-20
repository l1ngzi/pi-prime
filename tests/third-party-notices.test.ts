import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateNotices, lockedCrates } from "../scripts/generate-third-party-notices.mjs";

const project = new URL("../", import.meta.url);

test("the shipped notices cover every registry entry in Cargo.lock and the upstream terminal code", async () => {
	const lock = await readFile(new URL("src/terminal/native/Cargo.lock", project), "utf8");
	const crates = lockedCrates(lock);
	assert.equal(crates.length, lock.match(/^source = "registry\+/gm)!.length);
	assert.ok(crates.filter(crate => crate.name === "bitflags").length >= 2);
	assert.ok(!crates.some(crate => crate.name === "pi-prime-terminal"));
	const notices = await readFile(new URL("THIRD-PARTY-NOTICES.txt", project), "utf8");
	for (const { name, version } of crates) assert.ok(notices.includes(`\n${name} ${version} `), `${name} ${version}`);
	assert.match(notices, /OpenAI Codex, commit b8dceb0d/);
	assert.match(notices, /Copyright 2025 OpenAI\. Licensed under Apache-2\.0/);
	assert.match(notices, /Copyright \(c\) 2018-Present Wez Furlong[\s\S]*Permission is hereby granted[\s\S]*THE USE OR OTHER DEALINGS IN THE\nSOFTWARE\./);
});

test("the generator uses locked versions, reads nested notices and fails on a missing crate", async t => {
	const dir = await mkdtemp(join(tmpdir(), "pi-prime-notices-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const native = join(dir, "src/terminal/native");
	await mkdir(join(native, "src/win"), { recursive: true });
	await copyFile(new URL("NOTICE", project), join(dir, "NOTICE"));
	await copyFile(new URL("src/terminal/native/src/win/conpty.rs", project), join(native, "src/win/conpty.rs"));
	const lock = 'version = 4\n\n[[package]]\nname = "helper"\nversion = "1"\n\n[[package]]\nname = "example"\nversion = "2"\nsource = "registry+https://example.org"\n';
	await writeFile(join(native, "Cargo.lock"), lock);
	const crate = join(dir, "registry/src/index/example-2");
	assert.throws(() => generateNotices(dir, dir));
	await mkdir(join(crate, "upstream"), { recursive: true });
	await writeFile(join(crate, "LICENSE-MIT"), "Example copyright\r\n");
	await writeFile(join(crate, "upstream/NOTICE.txt"), "Nested attribution\n");
	const result = generateNotices(dir, dir);
	assert.match(result, /example 2 \/ LICENSE-MIT\n\nExample copyright/);
	assert.match(result, /example 2 \/ upstream\/NOTICE.txt\n\nNested attribution/);
	assert.match(result, /Copyright 2025 OpenAI/);
	assert.match(result, /Copyright \(c\) 2018-Present Wez Furlong/);
	await writeFile(join(native, "Cargo.lock"), lock.replace('version = "2"', 'version = "3"'));
	assert.throws(() => generateNotices(dir, dir), /Missing example 3.*cargo fetch --locked/);
});
