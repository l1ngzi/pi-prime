import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { test } from "node:test";

const artifactsUrl = new URL("../src/artifacts.ts", import.meta.url).href;
const loader = import.meta.resolve("tsx");
const content = "Retained output: 中文 😀\n";

for (const location of ["default", "absolute", "relative"] as const) {
	test(`${location} artifact root retains all tool output kinds at resolvable paths`, async () => {
		const temp = await realpath(tmpdir());
		const cwd = await realpath(await mkdtemp(join(temp, "pi-prime-artifacts-test-")));
		const defaultName = process.getuid ? `pi-prime-artifacts-${process.getuid()}` : "pi-prime-artifacts";
		const expected = location === "default" ? join(temp, defaultName) : join(cwd, "agent 日志", "tool-output");
		const env = { ...process.env };
		delete env.PI_PRIME_ARTIFACTS_DIR;
		if (location !== "default") env.PI_PRIME_ARTIFACTS_DIR = location === "absolute" ? expected : relative(cwd, expected);
		let directories: string[] = [];
		try {
			const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
				import { artifactDirectory, archiveText } from ${JSON.stringify(artifactsUrl)};
				import { writeFile } from 'node:fs/promises';
				import { join } from 'node:path';
				const terminal = join(artifactDirectory('terminal'), '123.log');
				await writeFile(terminal, ${JSON.stringify(content)});
				const code = await archiveText('codemode', 'output.txt', ${JSON.stringify(content)});
				console.log(JSON.stringify([terminal, code.path]));
			`], { cwd, env, encoding: "utf8", timeout: 15_000 });
			assert.equal(result.status, 0, result.stderr || String(result.error));
			const paths: string[] = JSON.parse(result.stdout);
			directories = await Promise.all(paths.map(path => realpath(dirname(path))));
			for (const path of paths) {
				assert.ok(isAbsolute(path));
				assert.equal(await realpath(dirname(dirname(path))), expected);
				assert.equal(await readFile(path, "utf8"), content);
			}
		} finally {
			for (const directory of directories) {
				assert.ok(directory.startsWith(temp + sep));
				await rm(directory, { recursive: true, force: true });
			}
			assert.ok(cwd.startsWith(temp + sep));
			await rm(cwd, { recursive: true, force: true });
		}
	});
}
