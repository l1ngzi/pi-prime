import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = path => readFileSync(path, "utf8").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();

/** @param {string} lock */
export function lockedCrates(lock) {
	return lock.split(/^\[\[package\]\]$/m).slice(1).filter(block => /^source = /m.test(block)).map(block => {
		const name = /^name = "([^"]+)"/m.exec(block)?.[1];
		const version = /^version = "([^"]+)"/m.exec(block)?.[1];
		if (!name || !version || !/^source = "registry\+/m.test(block)) throw new Error(`Unsupported Cargo.lock entry: ${block.trim()}`);
		return { name, version };
	});
}

function noticeFiles(dir) {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile())
		.map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.filter(file => /(?:^|\/)(?:(?:un)?licen[sc]es?|copying|copyright|(?:third[-_]party[-_])?notices?)(?:$|[./_-])/i.test(file)).sort();
}

export function generateNotices(project = root, cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo")) {
	const native = join(project, "src/terminal/native");
	const crates = lockedCrates(read(join(native, "Cargo.lock")));
	const cache = join(cargoHome, "registry/src");
	const registries = existsSync(cache) ? readdirSync(cache).sort() : [];
	const locate = ({ name, version }) => {
		const dir = registries.map(index => join(cache, index, `${name}-${version}`)).find(existsSync);
		if (!dir) throw new Error(`Missing ${name} ${version} in the Cargo cache. Run cargo fetch --locked --manifest-path src/terminal/native/Cargo.toml.`);
		return dir;
	};

	// Group identical texts while keeping the source of every notice visible.
	const texts = new Map();
	for (const crate of crates) {
		let dir = locate(crate);
		let files = noticeFiles(dir);
		let label = `${crate.name} ${crate.version}`;
		if (!files.length && /^winapi-(i686|x86_64)-pc-windows-gnu$/.test(crate.name)) {
			// These import-library crates ship only binaries and share winapi's project licenses.
			const winapi = crates.find(pkg => pkg.name === "winapi");
			dir = locate(winapi);
			files = noticeFiles(dir);
			label += ` (from winapi ${winapi.version})`;
		}
		if (!files.length) throw new Error(`No license or notice files found for ${label}`);
		for (const file of files) {
			const body = read(join(dir, file));
			if (!body) throw new Error(`Empty notice: ${label}/${file}`);
			if (!texts.has(body)) texts.set(body, []);
			texts.get(body).push(`${label} / ${file}`);
		}
	}

	const conpty = read(join(native, "src/win/conpty.rs")).match(/^\/\/ This file is copied from https:\/\/github\.com\/wezterm\/wezterm[^\n]*(?:\n\/\/[^\n]*)*/m);
	if (!conpty || !conpty[0].endsWith("// SOFTWARE.")) throw new Error("Missing complete WezTerm ConPTY license header");
	return [
		"Third-party notices for pi-prime",
		read(join(project, "NOTICE")),
		"WezTerm ConPTY (MIT)\n\n" + conpty[0].replace(/^\/\/ ?/gm, ""),
		"Rust dependency licenses and notices (Cargo.lock)",
		...Array.from(texts, ([body, sources]) => sources.join("\n") + "\n\n" + body),
	].join("\n\n" + "=".repeat(72) + "\n\n") + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	writeFileSync(join(root, "THIRD-PARTY-NOTICES.txt"), generateNotices());
}
