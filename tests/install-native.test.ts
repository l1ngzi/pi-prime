import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import fs, { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ChecksumError, installNative, parseChecksums, resolveAssetName, sha256Hex } from "../scripts/install-native.mjs";
import { resolveBinaryPath } from "../src/terminal/runtime.ts";

test("parseChecksums and resolveAssetName map supported platforms cleanly", () => {
	assert.equal(resolveAssetName("win32", "x64"), "pi-prime-terminal-win32-x64.exe");
	assert.equal(resolveAssetName("linux", "arm64"), "pi-prime-terminal-linux-arm64");
	assert.equal(resolveAssetName("darwin", "arm64"), "pi-prime-terminal-darwin-arm64");
	assert.equal(resolveAssetName("freebsd", "riscv64"), undefined);
	const map = parseChecksums("# comment\n" + "a".repeat(64) + "  pi-prime-terminal-linux-x64\n" + "B".repeat(64) + " *pi-prime-terminal-win32-x64.exe\n");
	assert.equal(map.get("pi-prime-terminal-linux-x64"), "a".repeat(64));
	assert.equal(map.get("pi-prime-terminal-win32-x64.exe"), "b".repeat(64));
});

test("installNative downloads prebuilt binary, verifies SHA-256, caches, rejects tampered checksums, and falls back to cargo on 404", async t => {
	const root = await mkdtemp(join(tmpdir(), "pi-prime-install-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-prime", version: "0.1.0" }));

	const asset = resolveAssetName("linux", "x64")!;
	const payload = Buffer.from("#!/bin/sh\necho ok\n");
	let servedSums = `${sha256Hex(payload)}  ${asset}\n`;
	let mode: "ok" | "404" = "ok";

	const server = createServer((req, res) => {
		if (mode === "404") { res.writeHead(404).end("not found"); return; }
		if (req.url === "/SHA256SUMS.txt") { res.writeHead(200).end(servedSums); return; }
		if (req.url === `/${asset}`) { res.writeHead(200).end(payload); return; }
		res.writeHead(404).end();
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	// 1. Skip env var
	const skipped = await installNative({ rootDir: root, env: { PI_PRIME_SKIP_NATIVE_INSTALL: "1" }, log: () => {} });
	assert.equal(skipped.source, "skipped");

	// 2. Prebuilt download + SHA-256 verify
	const installed = await installNative({
		rootDir: root, platform: "linux", arch: "x64",
		env: { PI_PRIME_RELEASE_BASE_URL: baseUrl }, log: () => {},
	});
	assert.equal(installed.source, "prebuilt");
	assert.ok(existsSync(installed.binaryPath!));
	assert.deepEqual(readFileSync(installed.binaryPath!), payload);
	if (process.platform !== "win32") assert.ok((statSync(installed.binaryPath!).mode & 0o111) !== 0);

	// 3. Cached rerun skips download
	const cached = await installNative({
		rootDir: root, platform: "linux", arch: "x64",
		env: { PI_PRIME_RELEASE_BASE_URL: "http://127.0.0.1:1" }, log: () => {},
	});
	assert.equal(cached.source, "cached");

	// 4. Tampered checksum fails loudly without falling back to cargo
	servedSums = `${"0".repeat(64)}  ${asset}\n`;
	let cargoCalled = false;
	await assert.rejects(
		installNative({
			rootDir: root, platform: "linux", arch: "x64",
			env: { PI_PRIME_RELEASE_BASE_URL: baseUrl, PI_PRIME_FORCE_INSTALL: "1" },
			spawnSync: () => { cargoCalled = true; return { status: 0 } as never; },
			log: () => {},
		}),
		ChecksumError,
	);
	assert.equal(cargoCalled, false, "checksum mismatch must never silently fall back to cargo");

	// 5. 404 falls back to cargo build cleanly
	mode = "404";
	const nativeDir = join(root, "src", "terminal", "native");
	mkdirSync(join(nativeDir, "target", "release"), { recursive: true });
	writeFileSync(join(nativeDir, "Cargo.toml"), '[package]\nname = "pi-prime-terminal"\n');
	const builtBytes = Buffer.from("CARGO_BUILT_BINARY");
	const fromSource = await installNative({
		rootDir: root, platform: "linux", arch: "x64",
		env: { PI_PRIME_RELEASE_BASE_URL: baseUrl, PI_PRIME_FORCE_INSTALL: "1" },
		spawnSync: (cmd: string, args: string[]) => {
			assert.equal(cmd, "cargo");
			assert.ok(args.includes("--locked"));
			writeFileSync(join(nativeDir, "target", "release", "pi-prime-terminal"), builtBytes);
			return { status: 0 } as never;
		},
		log: () => {},
	});
	assert.equal(fromSource.source, "source");
	assert.deepEqual(readFileSync(fromSource.binaryPath!), builtBytes);
});

test("resolveBinaryPath honors PI_PRIME_TERMINAL_BIN override and rejects nonexistent override", async t => {
	const dir = await mkdtemp(join(tmpdir(), "pi-prime-bin-override-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const fake = join(dir, "custom-terminal");
	writeFileSync(fake, "fake", { mode: 0o755 });
	const prev = process.env.PI_PRIME_TERMINAL_BIN;
	t.after(() => { if (prev === undefined) delete process.env.PI_PRIME_TERMINAL_BIN; else process.env.PI_PRIME_TERMINAL_BIN = prev; });

	process.env.PI_PRIME_TERMINAL_BIN = fake;
	assert.equal(resolveBinaryPath(), fake);

	process.env.PI_PRIME_TERMINAL_BIN = join(dir, "missing");
	assert.throws(() => resolveBinaryPath(), /PI_PRIME_TERMINAL_BIN does not exist/);
});

test("the runtime prefers bin/ and falls back to a raw Cargo build", t => {
	const name = process.platform === "win32" ? "pi-prime-terminal.exe" : "pi-prime-terminal";
	const installed = fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
	const raw = fileURLToPath(new URL(`../src/terminal/native/target/release/${name}`, import.meta.url));
	const available = new Set([installed, raw]);
	const executable = statSync(process.execPath);
	const previous = process.env.PI_PRIME_TERMINAL_BIN;
	delete process.env.PI_PRIME_TERMINAL_BIN;
	const access = t.mock.method(fs, "accessSync", (path: string) => assert.ok(available.has(path)));
	const stat = t.mock.method(fs, "statSync", () => executable);
	syncBuiltinESMExports();
	try {
		assert.equal(resolveBinaryPath(), installed);
		available.delete(installed);
		assert.equal(resolveBinaryPath(), raw);
	} finally {
		access.mock.restore();
		stat.mock.restore();
		syncBuiltinESMExports();
		if (previous !== undefined) process.env.PI_PRIME_TERMINAL_BIN = previous;
	}
});

const binaryName = "pi-prime-terminal";
const assetName = "pi-prime-terminal-linux-x64";
const mirror = "https://releases.example";
const releaseBytes = "release binary";
const fetchRelease = (url: string) => new Response(url.endsWith("/SHA256SUMS.txt")
	? `${sha256Hex(releaseBytes)}  ${assetName}\n` : releaseBytes);
const unexpected = () => assert.fail("Unexpected download or child process");

async function fixture(t: TestContext) {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-prime-installer-"));
	t.after(() => rm(rootDir, { recursive: true, force: true }));
	writeFileSync(join(rootDir, "package.json"), JSON.stringify({ version: "0.1.0", repository: "https://github.com/l1ngzi/pi-prime.git" }));
	mkdirSync(join(rootDir, "src/terminal/native"), { recursive: true });
	writeFileSync(join(rootDir, "src/terminal/native/Cargo.toml"), '[package]\nname = "pi-prime-terminal"\n');
	return { rootDir, platform: "linux", arch: "x64", env: {}, fetch: unexpected, spawnSync: unexpected, log() {} };
}

test("an explicit helper skips installation and a missing override fails even with a cached helper", async t => {
	const options = await fixture(t);
	const override = join(options.rootDir, "my helper");
	writeFileSync(override, "external helper");
	const env = { PI_PRIME_TERMINAL_BIN: override, PI_PRIME_BUILD_FROM_SOURCE: "1" };
	assert.deepEqual(await installNative({ ...options, env }), { source: "env", binaryPath: override });
	assert.equal(existsSync(join(options.rootDir, "bin")), false);
	await installNative({ ...options, fetch: fetchRelease });
	await assert.rejects(installNative({ ...options, env: { PI_PRIME_TERMINAL_BIN: override + "-missing" } }),
		/PI_PRIME_TERMINAL_BIN.*missing/);
});

test("forcing a source build replaces the cached binary with Cargo's reported target executable", async t => {
	const options = await fixture(t);
	const first = await installNative({ ...options, fetch: fetchRelease });
	assert.equal(first.source, "prebuilt");
	const target = "x86_64-unknown-linux-musl";
	const native = join(options.rootDir, "src/terminal/native");
	const custom = join(options.rootDir, "configured target", target, "release", binaryName);
	mkdirSync(join(options.rootDir, "configured target", target, "release"), { recursive: true });
	writeFileSync(custom, "fresh custom target");
	const built = await installNative({
		...options, env: { PI_PRIME_BUILD_FROM_SOURCE: "1", CARGO_BUILD_TARGET: target },
		spawnSync(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
			assert.equal(command, "cargo");
			assert.deepEqual(args, ["build", "--release", "--locked", "--message-format=json-render-diagnostics", "--manifest-path", join(native, "Cargo.toml")]);
			assert.equal(opts.cwd, native);
			assert.equal(opts.env.CARGO_BUILD_TARGET, target);
			const artifact = { reason: "compiler-artifact", target: { kind: ["bin"], name: binaryName }, executable: custom };
			return { status: 0, stdout: [
				JSON.stringify({ ...artifact, target: { kind: ["custom-build"], name: "build-script-build" }, executable: "wrong" }),
				JSON.stringify(artifact), '{"reason":"build-finished","success":true}',
			].join("\n") };
		},
	});
	assert.equal(built.source, "source");
	assert.equal(built.binaryPath, first.binaryPath);
	assert.equal(readFileSync(built.binaryPath!, "utf8"), "fresh custom target");
	assert.equal((await installNative(options)).source, "cached");
});

test("a checkout uses release assets only at the clean matching tag, including after a cache hit", async t => {
	const options = await fixture(t);
	const sourceBin = join(options.rootDir, "src/terminal/native/target/release", binaryName);
	mkdirSync(join(options.rootDir, "src/terminal/native/target/release"), { recursive: true });
	writeFileSync(sourceBin, "checkout build");
	writeFileSync(join(options.rootDir, ".git"), "gitdir: worktree");
	let head = "release", tag = "release", status = "";
	const spawnSync = (cmd: string, args: string[]) => {
		if (cmd === "cargo") return { status: 0, stdout: "" };
		assert.equal(cmd, "git");
		if (args[0] === "status") {
			assert.deepEqual(args, ["status", "--porcelain", "--untracked-files=all", "--", "src/terminal/native"]);
			return { status: 0, stdout: status };
		}
		if (args[1] === "HEAD") return { status: 0, stdout: head };
		assert.deepEqual(args, ["rev-parse", "-q", "--verify", "refs/tags/v0.1.0^{commit}"]);
		return { status: tag ? 0 : 1, stdout: tag };
	};
	const checkout = { ...options, spawnSync };
	assert.equal((await installNative({ ...checkout, fetch: fetchRelease })).source, "prebuilt");
	assert.equal((await installNative(checkout)).source, "cached");
	head = "new-main";
	assert.equal((await installNative(checkout)).source, "source");
	head = tag;
	status = "?? src/terminal/native/new.rs";
	assert.equal((await installNative(checkout)).source, "source");
	status = "";
	assert.equal((await installNative({ ...checkout, fetch: fetchRelease })).source, "prebuilt");
	tag = "";
	assert.equal((await installNative(checkout)).source, "source");
	assert.equal((await installNative({ ...options, env: { PI_PRIME_RELEASE_BASE_URL: mirror }, fetch: fetchRelease })).source, "prebuilt");
});

test("only HTTPS and loopback HTTP are fetched, including every redirect hop", async t => {
	const options = await fixture(t);
	for (const url of ["http://releases.example", "http://127.0.0.1.example", "ftp://localhost"]) {
		await assert.rejects(installNative({ ...options, env: { PI_PRIME_RELEASE_BASE_URL: url } }), /HTTPS required/);
	}
	const visited: string[] = [];
	await assert.rejects(installNative({ ...options, env: { PI_PRIME_RELEASE_BASE_URL: mirror },
		fetch(url: string, init: RequestInit) {
			visited.push(url);
			assert.equal(init.redirect, "manual");
			return Response.redirect(visited.length === 1 ? "https://cdn.example/sums" : "http://cdn.example/insecure");
		},
	}), /HTTPS required/);
	assert.deepEqual(visited, [mirror + "/SHA256SUMS.txt", "https://cdn.example/sums"]);
});

test("five redirects are followed and a sixth redirect fails before requesting the next URL", async t => {
	const options = await fixture(t);
	let redirects = 0;
	const fetch = (url: string) => {
		if (url.endsWith(assetName)) return fetchRelease(url);
		if (++redirects <= 5) return new Response(null, { status: 302, headers: { location: "/mirror/" + redirects } });
		return fetchRelease(mirror + "/SHA256SUMS.txt");
	};
	assert.equal((await installNative({ ...options, fetch })).source, "prebuilt");
	redirects = 0;
	await assert.rejects(installNative({ ...options, env: { PI_PRIME_FORCE_INSTALL: "1" }, fetch() {
		redirects++;
		return new Response(null, { status: 307, headers: { location: "/loop" } });
	} }), /too many redirects/);
	assert.equal(redirects, 6);
});

for (const [file, limit, chunkSize] of [["SHA256SUMS.txt", 64 * 1024, 1024], [assetName, 32 * 1024 * 1024, 1024 * 1024]] as const) {
	test(`${file} enforces its ${limit}-byte limit on a stream without Content-Length`, async t => {
		const options = await fixture(t);
		let cancelled = false;
		let sent = 0;
		const chunk = new Uint8Array(chunkSize);
		await assert.rejects(installNative({ ...options, fetch(url: string) {
			if (!url.endsWith(file)) return fetchRelease(url);
			return new Response(new ReadableStream({
				pull(controller) {
					controller.enqueue(chunk);
					if ((sent += chunk.length) > limit + 4 * chunkSize) controller.close();
				},
				cancel() { cancelled = true; },
			}));
		} }), new RegExp(`exceeds ${limit} bytes`));
		assert.equal(cancelled, true);
		assert.equal(existsSync(join(options.rootDir, "bin", binaryName)), false);
	});
}

for (const code of ["EPERM", "EBUSY"]) {
	test(`a locked installation (${code}) preserves the existing helper and never falls back to Cargo`, async t => {
		const options = await fixture(t);
		const { binaryPath } = await installNative({ ...options, fetch: fetchRelease });
		const rename = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("locked"), { code }); });
		syncBuiltinESMExports();
		t.after(() => { rename.mock.restore(); syncBuiltinESMExports(); });
		await assert.rejects(installNative({ ...options, env: { PI_PRIME_FORCE_INSTALL: "1" }, fetch: fetchRelease }),
			new RegExp(code + ".*Close active Pi sessions and retry"));
		assert.equal(readFileSync(binaryPath!, "utf8"), releaseBytes);
		assert.deepEqual(fs.readdirSync(join(options.rootDir, "bin")).sort(), [".version", binaryName]);
	});
}
