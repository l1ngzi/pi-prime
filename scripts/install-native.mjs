import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");

const ASSETS = {
	"win32-x64": "pi-prime-terminal-win32-x64.exe",
	"win32-arm64": "pi-prime-terminal-win32-arm64.exe",
	"linux-x64": "pi-prime-terminal-linux-x64",
	"linux-arm64": "pi-prime-terminal-linux-arm64",
	"darwin-arm64": "pi-prime-terminal-darwin-arm64",
	"darwin-x64": "pi-prime-terminal-darwin-x64",
};

class ReleaseAssetError extends Error {}

export class ChecksumError extends ReleaseAssetError {
	constructor(message) {
		super(message);
		this.name = "ChecksumError";
	}
}

export function resolveAssetName(platform = process.platform, arch = process.arch) {
	return ASSETS[`${platform}-${arch}`];
}

export function parseChecksums(text) {
	const map = new Map();
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
		if (!match) continue;
		map.set(match[2].trim(), match[1].toLowerCase());
	}
	return map;
}

export function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function repoBaseUrl(pkg) {
	const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
	if (!raw) return undefined;
	const cleaned = raw
		.replace(/^git\+/, "")
		.replace(/\.git$/, "")
		.replace(/^git@github\.com:/, "https://github.com/")
		.replace(/\/+$/, "");
	return cleaned.startsWith("http://") || cleaned.startsWith("https://")
		? `${cleaned}/releases/download/v${pkg.version}`
		: undefined;
}

function installExecutable(targetPath, platform, writeTemp) {
	const dir = dirname(targetPath);
	const tempPath = join(dir, `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
	try {
		mkdirSync(dir, { recursive: true });
		writeTemp(tempPath);
		if (platform !== "win32") chmodSync(tempPath, 0o755);
		renameSync(tempPath, targetPath);
	} catch (error) {
		try { rmSync(tempPath, { force: true }); } catch { /* Preserve the installation error. */ }
		if (error.code === "EPERM" || error.code === "EBUSY") {
			throw new Error(`Cannot replace ${targetPath} (${error.code}). Close active Pi sessions and retry.`, { cause: error });
		}
		throw error;
	}
}

function matchesRelease(rootDir, version, spawnImpl) {
	const git = (...args) => {
		const result = spawnImpl("git", args, { cwd: rootDir, encoding: "utf8" });
		return result.status === 0 ? result.stdout.trim() : undefined;
	};
	const tag = git("rev-parse", "-q", "--verify", `refs/tags/v${version}^{commit}`);
	return !!tag && tag === git("rev-parse", "HEAD") &&
		git("status", "--porcelain", "--untracked-files=all", "--", "src/terminal/native") === "";
}

async function fetchBuffer(url, limit, timeoutMs, fetchImpl) {
	let target = new URL(url);
	const signal = AbortSignal.timeout(timeoutMs);
	for (let redirects = 0; ; redirects++) {
		const loopback = target.hostname === "localhost" || target.hostname === "[::1]" || /^127(?:\.\d+){3}$/.test(target.hostname);
		if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) {
			throw new ReleaseAssetError(`HTTPS required for non-loopback downloads: ${target}`);
		}
		const response = await fetchImpl(target.href, {
			redirect: "manual", signal, headers: { "User-Agent": "pi-prime-installer" },
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location || redirects >= 5) throw new ReleaseAssetError(`Missing redirect location or too many redirects at ${target}`);
			target = new URL(location, target);
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status} ${response.statusText} for ${target}`);
		}
		const tooLarge = () => new ReleaseAssetError(`Download exceeds ${limit} bytes: ${target}`);
		if (Number(response.headers.get("content-length")) > limit) {
			await response.body?.cancel();
			throw tooLarge();
		}
		const chunks = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			size += chunk.byteLength;
			if (size > limit) throw tooLarge();
			chunks.push(chunk);
		}
		return Buffer.concat(chunks, size);
	}
}

async function downloadAsset(baseUrl, assetName, fetchImpl) {
	const sums = await fetchBuffer(`${baseUrl}/SHA256SUMS.txt`, 64 * 1024, 30_000, fetchImpl);
	const expected = parseChecksums(sums.toString("utf8")).get(assetName);
	if (!expected) throw new ChecksumError(`SHA256SUMS.txt at ${baseUrl} does not contain an entry for ${assetName}.`);
	const bytes = await fetchBuffer(`${baseUrl}/${assetName}`, 32 * 1024 * 1024, 60_000, fetchImpl);
	const actual = sha256Hex(bytes);
	if (actual !== expected) throw new ChecksumError(`SHA256 mismatch for ${assetName}: expected ${expected}, got ${actual}.`);
	return bytes;
}

function buildFromSource(rootDir, binaryName, env, spawnImpl) {
	const nativeDir = join(rootDir, "src", "terminal", "native");
	const manifestPath = join(nativeDir, "Cargo.toml");
	if (!existsSync(manifestPath)) throw new Error(`Rust sources not found at ${manifestPath}`);
	const result = spawnImpl("cargo",
		["build", "--release", "--locked", "--message-format=json-render-diagnostics", "--manifest-path", manifestPath],
		{ cwd: nativeDir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" },
	);
	if (result.error) throw new Error(`Could not run cargo: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`cargo build exited with status ${result.status}`);
	for (const line of (result.stdout ?? "").split(/\r?\n/)) {
		if (!line.startsWith("{")) continue;
		const message = JSON.parse(line);
		if (message.reason === "compiler-artifact" && message.target.name === "pi-prime-terminal" &&
			message.target.kind.includes("bin") && message.executable) return message.executable;
	}
	const fallback = join(nativeDir, "target", "release", binaryName);
	if (!existsSync(fallback)) throw new Error(`cargo build did not report an executable or produce ${fallback}`);
	return fallback;
}

export async function installNative(options = {}) {
	const rootDir = resolve(options.rootDir ?? DEFAULT_ROOT);
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const spawnImpl = options.spawnSync ?? spawnSync;
	const log = options.log ?? ((msg) => console.log(`[pi-prime] ${msg}`));

	// An explicit build refreshes bin/ even when postinstall is disabled or an override is in use.
	if (!options.build) {
		const override = env.PI_PRIME_TERMINAL_BIN?.trim();
		if (override) {
			const binaryPath = resolve(override);
			if (!statSync(binaryPath, { throwIfNoEntry: false })?.isFile()) {
				throw new Error(`PI_PRIME_TERMINAL_BIN does not point to an existing file: ${binaryPath}`);
			}
			return { source: "env", binaryPath };
		}
		if (env.PI_PRIME_SKIP_NATIVE_INSTALL === "1") return { source: "skipped" };
	}

	const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
	const binaryName = platform === "win32" ? "pi-prime-terminal.exe" : "pi-prime-terminal";
	const binaryPath = join(rootDir, "bin", binaryName);
	const versionPath = join(rootDir, "bin", ".version");
	const stamp = `${pkg.version}:${platform}-${arch}`;
	const mirror = env.PI_PRIME_RELEASE_BASE_URL?.trim();
	const checkout = existsSync(join(rootDir, ".git"));
	const useRelease = !options.build && env.PI_PRIME_BUILD_FROM_SOURCE !== "1" &&
		(!!mirror || !checkout || matchesRelease(rootDir, pkg.version, spawnImpl));

	if (useRelease && env.PI_PRIME_FORCE_INSTALL !== "1" && existsSync(binaryPath) && existsSync(versionPath) &&
		readFileSync(versionPath, "utf8").trim() === stamp) return { source: "cached", binaryPath };

	const assetName = resolveAssetName(platform, arch);
	const baseUrl = (mirror || repoBaseUrl(pkg))?.replace(/\/+$/, "");
	let downloadError;
	let bytes;
	if (useRelease && assetName && baseUrl) {
		try {
			bytes = await downloadAsset(baseUrl, assetName, options.fetch ?? globalThis.fetch);
		} catch (error) {
			if (error instanceof ReleaseAssetError) throw error;
			downloadError = error;
			log(`Prebuilt download failed (${error.message}); building from local Rust sources.`);
		}
	}
	if (bytes) {
		installExecutable(binaryPath, platform, temp => writeFileSync(temp, bytes));
		writeFileSync(versionPath, stamp + "\n");
		log(`Installed prebuilt ${assetName} (SHA256 verified).`);
		return { source: "prebuilt", binaryPath, assetName };
	}

	let builtPath;
	try {
		builtPath = buildFromSource(rootDir, binaryName, env, spawnImpl);
	} catch (error) {
		const reason = downloadError ? `Prebuilt download failed: ${downloadError.message}\n` : "";
		throw new Error(`${reason}Failed to build ${binaryName}: ${error.message}\nInstall Rust (https://rustup.rs) or set PI_PRIME_TERMINAL_BIN to an existing helper.`, { cause: error });
	}
	installExecutable(binaryPath, platform, temp => copyFileSync(builtPath, temp));
	// Unverified checkout sources must never satisfy a future release's version-only cache key.
	const versionedSource = !checkout || (useRelease && !mirror);
	writeFileSync(versionPath, (versionedSource ? stamp : stamp + ":source") + "\n");
	log(`Built ${binaryName} from local Rust sources.`);
	return { source: "source", binaryPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	installNative({ build: process.argv[2] === "--build" }).catch(error => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
