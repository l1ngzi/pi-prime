import { contentText } from "@earendil-works/pi-ai";
import { convertToLlm, sessionEntryToContextMessages, type ContextEditEntry, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolResultText } from "./history-text.ts";

// Session entry IDs already provide durable provenance. Reuse the branch log instead
// of creating another archive or rewriting old model context on every turn.
type HistoryRow = { id: string; timestamp: string; role: string; text: string };

function historyRows(entries: SessionEntry[]): HistoryRow[] {
	const edits = new Map<string, ContextEditEntry>();
	for (const entry of entries) {
		if (entry.type === "context_edit") edits.set(entry.targetId, entry);
	}
	return entries.flatMap<HistoryRow>((entry) => {
		const edit = edits.get(entry.id);
		if (edit?.replacement === null) return [];
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (!entry.summary) return [];
			return [{ id: entry.id, timestamp: entry.timestamp, role: entry.type,
				text: `[Historical ${entry.type === "compaction" ? "compaction" : "branch"} summary; check later user corrections]\n${entry.summary}` }];
		}
		const [original] = sessionEntryToContextMessages(entry);
		if (!original) return [];
		const replacement = edit?.replacement?.content;
		const message = replacement === undefined || !("content" in original) ? original : { ...original,
			content: typeof replacement === "string" ? [{ type: "text", text: replacement }] : replacement,
		} as typeof original;
		if (message !== original && message.role === "toolResult") delete message.nestedCalls;
		const parts = convertToLlm([message]).map((item) => {
			if (item.role === "assistant") {
				return `[assistant]\n${item.content.flatMap((block) => {
					if (block.type === "text") return [block.text];
					if (block.type === "toolCall") return [`${block.name}(${JSON.stringify(block.arguments)})`];
					return [];
				}).join("\n")}`;
			}
			if (item.role === "toolResult") return toolResultText(item);
			if (item.role === "user") {
				const label = message.role === "bashExecution" ? "bash execution" : message.role;
				return `[${label}]\n${contentText(item.content, "")}`;
			}
			return "";
		}).filter(Boolean);
		return parts.length ? [{ id: entry.id, timestamp: entry.timestamp,
			role: message.role === "bashExecution" ? "toolResult" : message.role, text: parts.join("\n\n") }] : [];
	});
}

function pageEntry(text: string, offset: number, header: string, entryId: string) {
	// A code point starting just before the boundary spans it if it needs two code units.
	const boundary = (index: number) => (text.codePointAt(index - 1) ?? 0) > 0xffff ? index - 1 : index;
	offset = boundary(offset);
	const end = boundary(Math.min(offset + 6000, text.length));
	const nextOffset = end < text.length ? end : undefined;
	const body = offset >= text.length ? `End of entry ${entryId} (${text.length} characters).`
		: `${header} | chars ${offset}–${end} / ${text.length}\n${text.slice(offset, end)}${nextOffset !== undefined ? `\nContinue with entryId=${entryId}, offset=${nextOffset}.` : ""}`;
	return { content: [{ type: "text" as const, text: body }], details: { entryId, nextOffset } };
}

function excerptStart(text: string, terms: string[], positions: number[], length: number): number {
	if (text.length <= length) return 0;
	const lower = text.toLocaleLowerCase();
	let best = 0, hits = 0;
	for (const position of positions) {
		if (position < 0) continue;
		const start = Math.max(0, Math.min(position - Math.floor(length / 3), text.length - length));
		const window = lower.slice(start, start + length);
		const score = terms.filter(term => window.includes(term)).length;
		if (score > hits) { best = start; hits = score; }
	}
	return best;
}

export default function sessionRecall(pi: ExtensionAPI): void {
	const sync = (_event: unknown, ctx: ExtensionContext) => {
		const enabled = ctx.sessionManager.getBranch().some(entry => entry.type === "compaction");
		const active = pi.getActiveTools();
		if (enabled === active.includes("session_recall")) return;
		pi.setActiveTools(enabled ? [...active, "session_recall"] : active.filter(name => name !== "session_recall"));
	};
	pi.on("session_start", sync);
	pi.on("session_compact", sync);
	pi.on("session_tree", sync);
	pi.on("before_agent_start", sync);
	pi.registerTool({
		name: "session_recall",
		label: "Recall session history",
		exposure: "direct",
		defaultActive: false,
		promptGuidelines: ["Use session_recall to recover an earlier decision, correction, or exact wording omitted by compaction."],
		description: "Recall this branch's history, including entries before compaction. Use {entryId} for visible text or {query, role?} to search. Later user corrections take precedence.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Space-separated words or quoted phrases. Any match can return an entry." })),
			entryId: Type.Optional(Type.String({ description: "Exact ID from a citation or search result. Supply either entryId or query." })),
			role: Type.Optional(Type.Enum(["user", "assistant", "toolResult", "custom", "compaction", "branch_summary"], { type: "string", description: "Filter query matches to one kind of entry." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Use the next offset shown in the previous response. Search offsets count entries and entry offsets count characters." })),
		}, { additionalProperties: false }),
		async execute(_id, { query, entryId, role, offset = 0 }, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (entryId !== undefined && (query !== undefined || role !== undefined)) {
				throw new Error("Use {entryId, offset?} or {query, role?, offset?}.");
			}
			if (entryId !== undefined && !entryId.trim()) throw new Error("Supply a cited or returned entryId.");
			const branch = ctx.sessionManager.getBranch();
			// Direct reads render only their target while retaining the branch's visibility edits.
			const rows = historyRows(entryId ? branch.filter((entry) => entry.id === entryId || entry.type === "context_edit") : branch);
			if (entryId) {
				const row = rows.find((item) => item.id === entryId);
				if (!row) throw new Error("Entry is not visible in the current branch. Search for its original topic instead.");
				return pageEntry(row.text, offset, `${row.id} | ${row.timestamp}`, entryId);
			}
			const terms = [...new Set([...((query ?? "").toLocaleLowerCase().matchAll(/"([^"]+)"|(\S+)/g))]
				.map((match) => match[1] ?? match[2]))].slice(0, 12);
			if (!terms.length) throw new Error("Provide query keywords or a cited or returned entryId.");
			const searched = role ? rows.filter((row) => row.role === role) : rows;
			const candidates = searched.map((row, index) => {
				const lower = row.text.toLocaleLowerCase();
				return { ...row, index, positions: terms.map((term) => lower.indexOf(term)) };
			});
			const weights = terms.map((_term, i) => Math.log(1 + searched.length / (1 + candidates.filter((row) => row.positions[i] >= 0).length)));
			const averageLength = searched.reduce((sum, row) => sum + row.text.length, 0) / Math.max(1, searched.length);
			// Binary-term BM25: a long code dump should not crowd out a short user correction.
			const ranked = candidates.map((row) => ({
				...row,
				termMatches: row.positions.filter((position) => position >= 0).length,
				score: row.positions.reduce((sum, position, i) => sum + (position >= 0 ? weights[i] : 0), 0)
					* 2.2 / (1 + 1.2 * (0.25 + 0.75 * row.text.length / Math.max(1, averageLength))),
			})).filter((row) => row.score > 0).sort((a, b) => b.termMatches - a.termMatches || b.score - a.score || b.index - a.index);
			const selected = ranked.slice(offset, offset + 5);
			if (!selected.length) return {
				content: [{ type: "text", text: ranked.length
					? `No more results at offset ${offset} (${ranked.length} matching entries).`
					: "No matching entries in the current branch. Try a distinctive phrase or widen the role filter." }],
				details: { matches: ranked.length, entries: [], nextOffset: undefined },
			};
			const excerpts = selected.map((row) => {
				const length = row.role === "user" ? 750 : 900;
				const start = excerptStart(row.text, terms, row.positions, length);
				// A correction may use different words from the request it supersedes.
				const later = row.role === "user"
					? rows.slice(rows.findIndex((item) => item.id === row.id) + 1).filter((item) => item.role === "user") : [];
				const nextUser = later[0];
				const following = nextUser ? `\nNext user turn ${nextUser.id}: ${nextUser.text.slice(0, 250)}${nextUser.text.length > 250 ? "…" : ""}` : "";
				const latest = later.length > 1 ? `\n${later.length} later user turns. Latest: entryId=${later.at(-1)!.id}.` : "";
				return `${row.id} | ${row.timestamp} | ${row.role} | excerpt at char ${start}\n${start ? "…" : ""}${row.text.slice(start, start + length)}${start + length < row.text.length ? "…" : ""}${following}${latest}`;
			});
			signal?.throwIfAborted();
			const nextOffset = offset + selected.length < ranked.length ? offset + selected.length : undefined;
			return {
				content: [{ type: "text", text: `Entries ${offset + 1}–${offset + selected.length} of ${ranked.length} matches in the current branch. Read entryId for the full visible text.\n\n${excerpts.join("\n\n")}${nextOffset !== undefined ? `\nMore results: repeat the query and role with offset=${nextOffset}.` : ""}` }],
				details: { matches: ranked.length, entries: selected.map((row) => row.id), nextOffset },
			};
		},
	});
}
