import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isDiscoverable } from "./tool-discovery.ts";

/** Map the wrapper's generated line back to the user's source. */
export function scriptDiagnostic(source: string, error: string): string {
	const lines = source.split(/\r?\n/);
	const header = lines[0].trimStart().startsWith("// @options:") ? 1 : 0;
	let location: { line: number; column?: number } | undefined;
	const mapped = error.replace(/codemode\.js:(\d+)(?::(\d+))?/g, (frame, row, col) => {
		const line = Number(row) - 1;
		if (line <= header || line > lines.length) return frame;
		location ??= { line, column: col ? Number(col) : undefined };
		return `codemode.js:${line}${col ? `:${col}` : ""}`;
	});
	if (!location) return mapped;
	const { line, column } = location;
	const excerpt = lines.slice(Math.max(header, line - 2), Math.min(lines.length, line + 1)).map((text, i) => {
		const row = Math.max(header, line - 2) + i + 1;
		const focus = row === line ? Math.max(0, (column ?? 1) - 1) : 0;
		const start = Math.max(0, Math.min(focus - 100, text.length - 220));
		const visible = text.slice(start, start + 220);
		return `${row === line ? ">" : " "} ${row} | ${start ? "…" : ""}${visible}${start + visible.length < text.length ? "…" : ""}`;
	}).join("\n");
	return `${mapped}\n\nSource (${line}${column ? `:${column}` : ""}):\n${excerpt}`;
}

function distance(a: string, b: string): number {
	let row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 0; i < a.length; i++) {
		const next = [i + 1];
		for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])));
		row = next;
	}
	return row[b.length];
}

export function compactArgumentError(error: string, toolName: string): string {
	const validation = error.startsWith(`Validation failed for tool "${toolName}":`);
	const malformed = error.startsWith(`Invalid arguments for tool "${toolName}":`);
	if (!validation && !malformed) return error;
	const [issue] = error.split("\n\nReceived arguments:\n", 1);
	const lines = issue.split("\n");
	return [
		...lines.slice(0, 9).map(line => line.length > 360 ? `${line.slice(0, 357)}…` : line),
		...(lines.length > 9 ? [`  … ${lines.length - 9} more validation errors`] : []),
		...(malformed ? ["Send the arguments again as a valid object matching the tool schema."] : []),
	].join("\n");
}

export function closestToolNames(missing: string, names: readonly string[]): string[] {
	return names.filter(name => Math.abs(name.length - missing.length) <= 2)
		.map(name => ({ name, distance: distance(missing, name) }))
		.filter(match => match.distance <= 2)
		.sort((a, b) => a.distance - b.distance)
		.slice(0, 3).map(match => match.name);
}

/** Tell the model how to reach a matching tool from the call path that failed. */
export function toolErrorHint(error: string, tools: readonly Pick<ToolInfo, "name" | "exposure">[], active: readonly string[], scriptOnly = false): string | undefined {
	const missing = /^Tool ([\p{L}\p{M}\p{N}_$.:/-]+) not found$/u.exec(error)?.[1];
	if (!missing) return;
	const routes = new Map<string, string>();
	for (const tool of tools) {
		const { name, exposure } = tool;
		if (exposure === "hidden") continue;
		const script = active.includes("codemode") && (isDiscoverable(tool) || (exposure === "direct" && active.includes(name)));
		if (active.includes(name) && !(scriptOnly && script)) {
			routes.set(name, `call ${name} directly`);
		} else if (!scriptOnly && isDiscoverable(tool) && active.includes("tool_search")) {
			routes.set(name, `load with tool_search({query:${JSON.stringify(name)}}), then call ${name} directly`);
		} else if (script) {
			routes.set(name, `use codemode and describeTool(${JSON.stringify(name)}) to get its script call`);
		}
	}
	const names = routes.has(missing) ? [missing] : closestToolNames(missing, [...routes.keys()]);
	if (names.length) return `Tool interface: ${names.map(name => routes.get(name)).join("; ")}.`;
}
