import type { ToolInfo } from "@earendil-works/pi-coding-agent";

type SearchableTool = Pick<ToolInfo, "name" | "description" | "parameters" | "namespace">;

// Add these only to discovery metadata, preserving the model's declared tools.
const aliases: Readonly<Record<string, string>> = {
	session_recall: "会话 聊天 历史 记录 原文 压缩 回忆 对话 上下文",
};

export function isDiscoverable(tool: Pick<ToolInfo, "exposure">): boolean {
	return tool.exposure === "deferred" || tool.exposure === "codemode";
}

// Also injected into QuickJS; keep this parser independent of host-side helpers.
export function parseToolQuery(query: string, known: ReadonlySet<string>): { names: string[]; explicit: boolean } {
	const tokens = [...new Set(query.match(/[\p{L}\p{M}\p{N}_$-]+(?:[.:][\p{L}\p{M}\p{N}_$-]+)*/gu) ?? [])];
	// Known names can be separated by spaces. Commas also allow a list to report a misspelling.
	const names = tokens.filter(name => known.has(name) || !/^(?:and|or)$/i.test(name));
	const explicit = names.some(name => known.has(name))
		&& (names.every(name => known.has(name)) || (query.includes(",") && query.split(",").every(part => /^[\w.$:-]+$/u.test(part.trim()))));
	return { names: explicit ? names : tokens, explicit };
}

export function searchDescription(tool: Pick<SearchableTool, "name" | "description">): string {
	return [tool.description, aliases[tool.name]].filter(Boolean).join("\n");
}
