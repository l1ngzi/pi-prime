import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function readQuotaFile(file: string): string | undefined {
	try { return readFileSync(`/sys/fs/cgroup/${file}`, "utf8").trim(); }
	catch { return undefined; }
}

function cpuParallelism(): number {
	const parallelism = availableParallelism();
	if (process.platform !== "linux") return parallelism;
	// libuv can report the full affinity mask in quota-limited containers.
	const max = readQuotaFile("cpu.max");
	const [quota, period] = (max === undefined
		? [readQuotaFile("cpu/cpu.cfs_quota_us"), readQuotaFile("cpu/cpu.cfs_period_us")]
		: max.split(/\s+/)).map(Number);
	return quota > 0 && period > 0 ? Math.min(parallelism, Math.ceil(quota / period)) : parallelism;
}

function memorySize(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
	let unit = 0;
	while (bytes >= 1024 && unit < units.length - 1) {
		bytes /= 1024;
		unit++;
	}
	return `${Number(bytes.toFixed(2))} ${units[unit]}`;
}

export function executionResourceSummary(): string {
	const total = totalmem();
	const limit = process.constrainedMemory();
	const memory = limit > 0 && limit <= total ? `The OS reports a memory constraint of ${memorySize(limit)}.` : `Total system memory is ${memorySize(total)}.`;
	return `Estimated CPU parallelism is ${cpuParallelism()}. ${memory}`;
}

export default function executionResources(pi: ExtensionAPI): void {
	let summary: string | undefined;
	pi.on("session_start", () => { summary = undefined; });
	pi.on("before_agent_start", ({ systemPromptOptions }) => {
		summary ??= executionResourceSummary();
		systemPromptOptions.sections.execution_resources ??= summary;
	});
}
