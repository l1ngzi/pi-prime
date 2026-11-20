import { stripVTControlCharacters } from "node:util";
import { createCodemodeExtension, type CodemodeToolDetails, type ExtensionAPI, type ExtensionToolContext, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { terminalOutputSchema } from "./terminal/output.ts";
import { formatKeys, isOutput, sessionTag, statusLine, styleOutput } from "./terminal/render.ts";
import type { TerminalOutput } from "./terminal/runtime.ts";
import { closestToolNames, compactArgumentError, scriptDiagnostic, toolErrorHint } from "./tool-diagnostics.ts";
import { parseToolQuery, searchDescription } from "./tool-discovery.ts";
import { configureToolMode, defaultToolOptions } from "./tool-mode.ts";
import { archiveText } from "./artifacts.ts";
import type { FileMutationOutcome } from "./file-contract.ts";

type Call = CodemodeToolDetails["calls"][number];
const DEFAULT_SCRIPT_OUTPUT_TOKENS = 10000;

const clean = (text: string) => stripVTControlCharacters(text).replace(/\r/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￹-￻]/g, "");

// Call previews are compact JSON cut at 200 characters, so recover the leading fields leniently.
function parseArgs(args: string): Record<string, unknown> {
	try {
		const value = JSON.parse(args);
		if (value && typeof value === "object") return value;
	} catch {}
	const fields: Record<string, unknown> = {};
	for (const [, key, literal, body, closed] of args.matchAll(/"(\w+)":(?:(-?\d+(?:\.\d+)?|true|false)|"((?:[^"\\]|\\.)*)(")?)/g)) {
		if (literal !== undefined) { fields[key] = JSON.parse(literal); continue; }
		const raw = closed ? body : body.replace(/\.\.\.$/, "").replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, "");
		try { fields[key] = JSON.parse(`"${raw}"`) + (closed ? "" : "…"); } catch { fields[key] = raw; }
	}
	return fields;
}

function formatTerminalCall(call: Call, theme: Theme): Call {
	if (call.name === "exec_command") {
		const { cmd, tty } = parseArgs(call.args);
		if (typeof cmd === "string") {
			const [first, ...rest] = clean(cmd).trim().split("\n");
			const more = rest.length ? ` +${rest.length} lines` : "";
			return { ...call, name: process.platform === "win32" ? "PS>" : "$", args: first + more + (tty ? " TTY" : "") };
		}
	}
	if (call.name === "write_stdin") {
		const { session_id, chars, interrupt } = parseArgs(call.args);
		if (typeof session_id === "number" && Number.isSafeInteger(session_id) && session_id > 0) {
			const args = interrupt || chars === "\x03" ? "^C interrupt"
				: typeof chars === "string" && chars ? `› ${stripVTControlCharacters(formatKeys(chars, theme, true)).trimEnd()}`
				: "⋯ collect output";
			return { ...call, name: sessionTag(theme, session_id), args };
		}
	}
	return call;
}

// The status leads each block: collapsed previews keep the start, so it stays visible.
function terminalBlock(output: TerminalOutput, theme: Theme, label?: string): string {
	const status = (label ? theme.fg("muted", `${label}  `) : "") + statusLine(output, theme);
	const body = styleOutput({ ...output, output: clean(output.output) }, theme);
	return body ? `${status}\n${body}` : status;
}

// Arbitrary script objects keep their JSON if a card would hide fields or invent a process state.
function isTerminalOutput(value: unknown): value is TerminalOutput {
	return Check(terminalOutputSchema, value)
		&& (value.session_id !== undefined) !== (value.exit_code !== undefined)
		&& (value.termination_reason === undefined || value.exit_code !== undefined);
}

// Old sessions may contain empty reasons; keep richer error metadata as JSON.
function rejection(reason: unknown): string | undefined {
	if (typeof reason === "string") return reason;
	if (!reason || typeof reason !== "object" || Array.isArray(reason)) return undefined;
	const keys = Object.keys(reason);
	if (!keys.length) return "rejected";
	if ("message" in reason && typeof reason.message === "string" && keys.every(key => key === "name" || key === "message")) {
		const name = "name" in reason ? reason.name : undefined;
		if (name !== undefined && typeof name !== "string") return undefined;
		return name && name !== "Error" ? `${name}: ${reason.message}` : reason.message;
	}
	return undefined;
}

// Promise.all / Promise.allSettled arrays and { name: result } maps of terminal results.
function terminalBlocks(value: unknown, theme: Theme): string | undefined {
	if (isTerminalOutput(value)) return terminalBlock(value, theme);
	const entries = Array.isArray(value) ? value.map((item, i) => [value.length > 1 ? `[${i}]` : undefined, item] as const)
		: value && typeof value === "object" ? Object.entries(value) : [];
	if (!entries.length) return undefined;
	const blocks: string[] = [];
	for (const [label, item] of entries) {
		const settled = item && typeof item === "object" && "status" in item && Object.keys(item).length === 2
			? item as { status: unknown; value?: unknown; reason?: unknown } : undefined;
		if (isTerminalOutput(item)) blocks.push(terminalBlock(item, theme, label));
		else if (settled?.status === "fulfilled" && isTerminalOutput(settled.value)) blocks.push(terminalBlock(settled.value, theme, label));
		else if (settled?.status === "rejected") {
			const message = rejection(settled.reason);
			if (message === undefined) return undefined;
			blocks.push((label ? theme.fg("muted", `${label}  `) : "") + theme.fg("error", `✗ ${clean(message)}`));
		}
		else return undefined;
	}
	return blocks.join("\n\n");
}

function formatJson(text: string, theme: Theme): string {
	const json = text.trim();
	if (!json.startsWith("{") && !json.startsWith("[")) return text;
	try {
		const value: unknown = JSON.parse(json);
		return text.replace(json, () => terminalBlocks(value, theme) ?? JSON.stringify(value, null, 2));
	} catch { return text; }
}

function formatOutput(text: string, theme: Theme): string {
	// Pi joins adjacent text() results and labels them. Keep those boundaries in the preview.
	return text.split(/(?=^(?:==> text \d+\/\d+ <==|<console_output>|Script error:)\r?$)/m).map(section => {
		const heading = /^==> text \d+\/\d+ <==\r?\n/.exec(section)?.[0] ?? "";
		return heading + formatJson(section.slice(heading.length), theme);
	}).join("");
}

// QuickJS freezes its built-ins. Scope output adapters to this script instead:
// Errors keep their fields. text/console/return preserve ordinary data; image() opts into decoding.
const serializeOutput = `(value, asText = false, safeFallback = true) => {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
	const toErrorPlain = item => {
		const error = { ...item, name: item.name, message: item.message };
		for (const key of ["cause", "errors"]) if (key in item) error[key] = item[key];
		return error;
	};
	try {
		const errors = new WeakMap();
		const json = JSON.stringify(value, (_key, item) => {
			if (!(item instanceof Error)) return item;
			let error = errors.get(item);
			if (!error) { error = toErrorPlain(item); errors.set(item, error); }
			return error;
		});
		return json === undefined ? value : !asText && json.startsWith('"') ? JSON.parse(json) : json;
	} catch (error) {
		if (!safeFallback) throw error;
		const stack = new WeakSet();
		const sanitize = item => {
			if (typeof item === "bigint") return String(item) + "n";
			if (item === null || typeof item !== "object") return item;
			if (stack.has(item)) return "[Circular]";
			stack.add(item);
			try {
				if (typeof item.toJSON === "function") return sanitize(item.toJSON());
				if (Array.isArray(item)) return item.map(sanitize);
				const source = item instanceof Error ? toErrorPlain(item) : item;
				const copy = {};
				for (const key of Object.keys(source)) copy[key] = sanitize(source[key]);
				return copy;
			} finally { stack.delete(item); }
		};
		const json = JSON.stringify(sanitize(value));
		return json ?? String(value);
	}
}`.replace(/\n\s*/g, " ");
const identifierPattern = /^[^A-Za-z_$]|[^A-Za-z0-9_$]/gu;
const scriptIdentifier = (name: string) => name.replace(identifierPattern, "_") || "_";
// Exact multi-name queries keep query order. Capability queries use Pi's ranker.
const searchScope = `(index, knownNames, rank, identifier, parseQuery) => async (query, options) => {
	if (typeof query !== "string" || (options?.namespace != null && typeof options.namespace !== "string")
		|| !Number.isInteger(options?.limit ?? 8) || (options?.limit ?? 8) <= 0) return rank(query, options);
	const candidates = options?.namespace ? index.filter(tool => tool.namespaces?.some(name => identifier(name) === identifier(options.namespace))) : index;
	const { names, explicit } = parseQuery(query, new Set([...knownNames, ...index.flatMap(tool => [tool.name, tool.id])]));
	if (!explicit) return rank(query, options);
	const exact = [...new Set(names.flatMap(term => candidates.filter(tool => tool.name === term || tool.id === term).map(tool => tool.id)))];
	const unavailable = names.filter(term => !candidates.some(tool => tool.name === term || tool.id === term));
	if (unavailable.length) globalThis.console.warn("Tools unavailable in this script: " + unavailable.join(", ") + ". Check the names or search for the capability separately.");
	return Promise.all(exact.slice(0, options?.limit ?? 8).map(async name => ({ name, description: await globalThis.describeTool(name) })));
}`.replace(/\n\s*/g, " ");

const outputScope = `return await (async (__piPrimeSerializeOutput, searchTools) => {
	let storeChanged = false;
	const store = (key, value) => { const result = globalThis.store(key, value); storeChanged = true; return result; };
	const image = value => {
		if (value && typeof value === "object" && !("type" in value) && Array.isArray(value.content)) {
			const blocks = value.content.filter(part => part && typeof part === "object" && part.type === "image");
			if (blocks.length) { let last; for (const block of blocks) last = globalThis.image(block); return last; }
		}
		return globalThis.image(typeof value === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(value) ? { type: "image", data: value } : value);
	};
	const describeTool = async name => {
		const description = await globalThis.describeTool(name);
		if (description === undefined) throw new Error("Tool " + JSON.stringify(name) + " is not available in this script. Use searchTools to find a callable tool.");
		return description;
	};
	const text = value => globalThis.text(__piPrimeSerializeOutput(value, true));
	const console = Object.freeze(Object.fromEntries(["log", "info", "warn", "error", "debug"].map(
		level => [level, (...args) => globalThis.console[level](...args.map(value => {
			if (value instanceof Error) return value;
			try { return __piPrimeSerializeOutput(value, true, false); } catch { return value; }
		}))]
	)));
	try { return __piPrimeSerializeOutput(await (async () => {`.replace(/\n\s*/g, " ");

function wrapScript(code: string, ctx?: ExtensionToolContext, pi?: ExtensionAPI): string {
	if (!code.trim()) return code;
	// Let the original parser diagnose misplaced headers against the user's input.
	if (code.split(/\r?\n/).some((line, index) => index > 0 && line.trimStart().startsWith("// @options:"))) return code;
	const newline = code.indexOf("\n");
	const firstLine = newline === -1 ? code : code.slice(0, newline);
	const hasOptions = firstLine.trimStart().startsWith("// @options:");
	// Preserve the bundled parser's errors for an options line without a script.
	if (hasOptions && (newline === -1 || !code.slice(newline + 1).trim())) return code;
	const header = hasOptions ? code.slice(0, newline + 1) : "";
	const body = hasOptions ? code.slice(newline + 1) : code;
	// Put user code on its own line, preserving columns and directive prologues.
	// scriptDiagnostic maps the one generated line back to the original source.
	const registry = new Map(pi?.getAllTools().map(tool => [tool.name, tool]));
	const index = ctx?.tools.map(tool => {
		const namespace = registry.get(tool.name)?.namespace;
		return { name: tool.name, id: scriptIdentifier(tool.name), namespaces: namespace && [namespace.name, ...(namespace.aliases ?? [])] };
	});
	const search = index ? `(${searchScope})(${JSON.stringify(index)}, ${JSON.stringify([...registry.keys()])}, globalThis.searchTools, name => name.replace(${identifierPattern}, "_") || "_", ${parseToolQuery.toString()})` : "globalThis.searchTools";
	return header + outputScope + "\n" + body + '\n})()); } catch (error) { if (storeChanged) globalThis.console.warn("Store changes from this script were not saved; previously saved values remain."); throw error; } })(' + serializeOutput + ", " + search + ");";
}

type NestedCall = {
	id?: string;
	name: string;
	summary?: string;
	/** Keep returned data until the parent script reports success or failure. */
	terminal?: TerminalOutput;
	sessionId?: number;
	/** Set when the call ends; absent while it is in flight. */
	status?: "ok" | "error";
	late?: boolean;
	/** The call reported a terminal session that may still be running. */
	running?: boolean;
};
type Receipt = { direct: ReadonlySet<string>; calls: NestedCall[]; completedSessions: Set<number>; onSettled?: () => void };
type NestedOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

const UNKNOWN_OUTCOME = "outcome not yet available; inspect current state before repeating actions";
// When a script stops awaiting a call, Pi aborts the call without waiting for it to end.
// A command launch in progress still reports its session moments later.
const PENDING_CALL_GRACE_MS = 1000;

const inFlight = (receipt: Receipt) => receipt.calls.some(call => !call.status);

/** Give calls the script stopped awaiting a bounded chance to report how they ended. */
function awaitPendingCalls(receipt: Receipt): Promise<void> {
	return new Promise(resolve => {
		const done = () => { clearTimeout(timer); receipt.onSettled = undefined; resolve(); };
		const timer = setTimeout(done, PENDING_CALL_GRACE_MS);
		receipt.onSettled = done;
	});
}

function terminalNextStep(name: "write_stdin" | "terminal_sessions", args: string, direct: ReadonlySet<string>): string {
	return direct.has(name) ? `Call ${name}(${args}).` : `In codemode, use tools.${name}(${args}).`;
}

function terminalOutput(name: string, result: { structuredContent?: unknown }): TerminalOutput | undefined {
	const output = name === "exec_command" || name === "write_stdin" ? result.structuredContent : undefined;
	return isTerminalOutput(output) ? output : undefined;
}

function recordTerminalResult(receipt: Receipt, call: NestedCall, result: { structuredContent?: unknown }): TerminalOutput | undefined {
	const terminal = terminalOutput(call.name, result);
	if (!terminal) return;
	call.terminal = terminal;
	call.sessionId = terminal.session_id ?? call.sessionId;
	if (terminal.exit_code !== undefined && call.sessionId !== undefined) receipt.completedSessions.add(call.sessionId);
	return terminal;
}

const READ_ONLY_TOOLS = new Set(["read", "session_recall", "tool_search"]);

/** One recovery receipt per call; a normal poll's consumed output survives a later script error. */
async function nestedReport(calls: readonly NestedCall[], failed: boolean, visible: string): Promise<string | undefined> {
	const shown = (text: string) => Boolean(text) && (visible.includes(text) || visible.includes(JSON.stringify(text).slice(1, -1)));
	const records = calls.flatMap((call, index) => {
		const recover = failed || call.late;
		if (!recover && call.status && !call.running) return [];
		const id = call.id ?? String(index + 1);
		const terminalShown = Boolean(call.terminal && shown(JSON.stringify(call.terminal)));
		if (!recover && (!call.summary || shown(call.summary) || terminalShown)) return [];
		if (call.status === "ok" && !call.summary && !call.terminal && READ_ONLY_TOOLS.has(call.name)) return [];
		const state = call.running && call.terminal?.cancelled ? "wait stopped" : call.status ?? "outcome unknown";
		const summary = call.summary && shown(call.summary) ? undefined
			: recover && call.terminal && !terminalShown ? call.summary?.replace(/ (?:Full output|Partial log): .+$/, "") : call.summary;
		const label = `- ${call.name} [${id}] (${state})${summary ? `: ${summary}` : ""}`;
		if (!recover || !call.terminal || terminalShown || (!call.terminal.output && !call.terminal.full_output_path)) return [label];
		const { output, ...status } = call.terminal;
		const omitOutput = Boolean(output && shown(output));
		return [`${label}\n${JSON.stringify(status)}${output && !omitOutput ? `\n${output}` : ""}`];
	});
	if (!records.length) return;
	const heading = "Nested tool outcomes (completed actions remain in effect):";
	const body = records.join("\n\n");
	if (body.length <= 4000) return `${heading}\n${body}`;
	try {
		const saved = await archiveText("codemode", "terminal-results.txt", body);
		return `${heading}\nRead the ${saved.truncated ? "archived excerpt" : "complete results"} at ${saved.path}.\nPreview:\n${body.slice(0, 1500)}\n[Preview ends.]`;
	} catch {
		return `${heading}\n${body.slice(0, 3000)}\n[Additional results could not be archived.]\n${body.slice(-1000)}`;
	}
}

function fileOutcome(details: unknown, path: string): string {
	if (details && typeof details === "object" && "changed" in details && "path" in details) {
		const file = details as FileMutationOutcome;
		return `${file.changed ? "file action completed" : "no write needed"}: ${JSON.stringify(file.path)}`;
	}
	return `file action completed: ${JSON.stringify(path)}`;
}

function nestedOutcome(name: string, outcome: Pick<NestedOutcome, "result" | "isError">, direct: ReadonlySet<string>): string | undefined {
	const terminal = terminalOutput(name, outcome.result);
	if (terminal) {
		if (terminal.session_id !== undefined) {
			const state = terminal.cancelled ? "wait stopped; process may still be running" : "process still running";
			return `${state}. ${terminalNextStep("write_stdin", `{session_id:${terminal.session_id}}`, direct)}${terminal.full_output_path ? ` ${terminal.log_truncated ? "Partial log" : "Full output"}: ${terminal.full_output_path}` : ""}`;
		}
		if (terminal.exit_code === 0) return;
		return `command ${terminal.termination_reason === "ctrl_c" ? "interrupted, " : ""}exited with code ${terminal.exit_code}${terminal.full_output_path ? `. Full output: ${terminal.full_output_path}` : ""}`;
	}
	if (!outcome.isError) return;
	const message = outcome.result.content.find(part => part.type === "text")?.text.trim();
	return message ? compactArgumentError(message, name).slice(0, 700) : "call failed";
}

function alignTruncation(text: string): string {
	if (!text.startsWith("Warning: truncated output (original token count:")) return text;
	return text.replace(/([^]*?)…\d+ tokens truncated…([^]*)/, (_match, head: string, tail: string) => {
		const header = /Total output lines: \d+\r?\n\r?\n/.exec(head);
		const bodyStart = header ? header.index + header[0].length : 0;
		const footerAt = tail.indexOf("\n\n[Full output:");
		const footer = footerAt < 0 ? "" : tail.slice(footerAt);
		if (footerAt >= 0) tail = tail.slice(0, footerAt);
		const end = head.lastIndexOf("\n"), start = tail.indexOf("\n");
		if (end >= bodyStart) head = head.slice(0, end + 1);
		if (start >= 0) tail = tail.slice(start + 1);
		return `${head.trimEnd()}\n... output truncated ...\n${tail}${footer}`;
	});
}

function scriptDescription(description: string): string {
	const docsPath = /Read (.+codemode\.md) first\./.exec(description)?.[1];
	const nestedAt = description.indexOf("\n\nNested tools:");
	const nested = nestedAt < 0 ? "" : description.slice(nestedAt);
	const lines = [
		"Run JavaScript in QuickJS with top-level await and return. Use tools for files, shell and network access. For Node APIs such as Buffer and process, run Node in the terminal.",
		"- `await tools.<name>(args)` returns text or the declared structured result. Calls without structured error results throw on failure. Check returned status before dependent work; for a shell command, exit_code=0 means success and session_id allows another wait.",
		"- Pending waits stop when the script ends. Started processes and completed actions can remain in effect.",
		`- Optional first line: \`// @options: {"max_output_tokens": ${DEFAULT_SCRIPT_OUTPUT_TOKENS}}\`. This is the default output budget. Set timeout_ms for a script-wide deadline. Without it, each tool uses its own wait settings.`,
		"",
		"Globals:",
		"- `text(value)`, `image(imageBlockOrDataUrlOrBase64)`, `console.log(...)`, and `return` show results. Pass Errors and Promise.allSettled results directly to preserve error fields. Use `exit()` to end the script.",
		"- `store(key, value)` and `load(key)` share JSON on this branch. Store changes are saved only when the script succeeds.",
		"- `ALL_TOOLS`, `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, and `await describeNamespace(name)` discover callable tools. Call them with `tools`.",
		`- \`models\`: classifiers and image generation.${docsPath ? ` Models API reference: ${docsPath}.` : ""}`,
	];
	return lines.join("\n") + nested;
}

function discoveryContext(ctx: ExtensionToolContext, receipt: Receipt): ExtensionToolContext {
	const executeTool: ExtensionToolContext["executeTool"] = async (name, args, options) => {
		const parameters = args as { path?: unknown; session_id?: unknown } | undefined;
		const filePath = (name === "write" || name === "edit") && typeof parameters?.path === "string" ? parameters.path : undefined;
		const sessionId = name === "write_stdin" && typeof parameters?.session_id === "number" ? parameters.session_id : undefined;
		const terminalTool = name === "exec_command" || name === "write_stdin";
		const summary = terminalTool
			? `${UNKNOWN_OUTCOME}. ${terminalNextStep("terminal_sessions", '{action:"list"}', receipt.direct)}` : UNKNOWN_OUTCOME;
		const call: NestedCall = { name, summary, sessionId };
		receipt.calls.push(call);
		try {
			const outcome = await ctx.executeTool(name, args, {
				...options,
				onUpdate(partial) {
					const terminal = recordTerminalResult(receipt, call, partial);
					const summary = nestedOutcome(name, { result: partial, isError: false }, receipt.direct);
					if (summary || terminal) {
						call.summary = summary;
						call.running = terminal?.session_id !== undefined;
					}
					options?.onUpdate?.(partial);
				},
			});
			call.id = outcome.toolCall?.id;
			const { result, isError } = outcome;
			const terminal = recordTerminalResult(receipt, call, result);
			call.status = isError ? "error" : "ok";
			const state = result.structuredContent;
			if (name === "terminal_sessions" && !isError && state && typeof state === "object"
				&& "closed_session_id" in state && typeof state.closed_session_id === "number") receipt.completedSessions.add(state.closed_session_id);
			// Cancellation can omit the recovery data already reported in a partial result.
			if (!(isError && !state && call.terminal)) {
				call.summary = nestedOutcome(name, outcome, receipt.direct);
				call.running = terminal?.session_id !== undefined;
				if (!isError && filePath) call.summary = fileOutcome(result.details, filePath);
				else if (!isError && !terminal && !READ_ONLY_TOOLS.has(name)) {
					call.summary = result.content.find(part => part.type === "text")?.text.slice(0, 500).trim();
				}
			}
			const content = outcome.isError ? outcome.result.content.map(part => part.type === "text" ? { ...part, text: compactArgumentError(part.text, name) } : part) : outcome.result.content;
			return { ...outcome, result: { ...outcome.result, content } };
		} catch (error) {
			call.status = "error";
			call.summary = compactArgumentError(error instanceof Error ? error.message : String(error), name).slice(0, 700);
			throw error;
		} finally {
			// Pi aborts pending calls when its sandbox closes, before tool.execute returns.
			call.late = options?.signal?.aborted || !!receipt.onSettled;
			if (!inFlight(receipt)) receipt.onSettled?.();
		}
	};
	return Object.create(ctx, {
		executeTool: { value: executeTool },
		tools: { value: ctx.tools.map(tool => ({ ...tool, description: searchDescription(tool) })) },
	}) as ExtensionToolContext;
}

// Replaces Pi's built-in codemode automatically; disable "-builtin:codemode" to silence the startup notice.
export default function codemode(pi: ExtensionAPI): void {
	// Validation and unknown-tool failures skip tool_result, but still end a message.
	pi.on("message_end", ({ message }) => {
		if (message.role !== "toolResult" || !message.isError) return;
		const error = message.content.filter(item => item.type === "text").map(item => item.text).join("\n");
		const compact = compactArgumentError(error, message.toolName);
		const active = pi.getActiveTools();
		const hint = toolErrorHint(error, pi.getAllTools(), active, mode.mode === "only" && active.includes("codemode"));
		if (compact !== error || hint) {
			const content = compact === error ? message.content : [{ type: "text" as const, text: compact }];
			return { message: { ...message, content: hint ? [...content, { type: "text", text: hint }] : content } };
		}
	});
	const mode = configureToolMode(pi);
	createCodemodeExtension({
		get mode() { return mode.mode; },
	})({
		...pi,
		registerTool(definition) {
			const tool = definition as ToolDefinition;
			pi.registerTool({
				...tool,
				...defaultToolOptions(),
				description: scriptDescription(tool.description),
				prepareLoadout(loadout) {
					const prepared = tool.prepareLoadout?.(loadout);
					const description = prepared?.descriptions?.[tool.name] ?? tool.description;
					const docs = scriptDescription(description);
					// A mid-run model switch rebuilds descriptions but reuses the system prompt rules,
					// so routing that depends on the tool surface lives here and the rule below fits both.
					const routing = mode.mode === "only"
						? "Use codemode for routine calls to the tools listed here, batching independent calls in one script. Find more callable tools with searchTools(query)."
						: "Call other tools directly for straightforward calls and independent parallel work. Use codemode for dependent chains, filtering, and aggregation.";
					return { ...prepared, descriptions: { ...prepared?.descriptions, [tool.name]: `${routing}\n\n${docs}` } };
				},
				promptGuidelines: undefined,
				async execute(id, params, signal, onUpdate, ctx) {
					const input = params as { code: string };
					const active = new Set(ctx?.tools ? pi.getActiveTools() : []);
					const direct = new Set((ctx?.tools ? pi.getAllTools() : []).filter(tool => active.has(tool.name)
						&& (tool.exposure === "deferred" || (mode.mode === "on" && tool.exposure === "direct"))).map(tool => tool.name));
					const receipt: Receipt = { direct, calls: [], completedSessions: new Set() };
					const nested = ctx?.tools ? discoveryContext(ctx, receipt) : undefined;
					const result = await tool.execute(id, { ...input, code: wrapScript(input.code, nested, pi) }, signal, onUpdate, nested ?? ctx);
					if (inFlight(receipt)) await awaitPendingCalls(receipt);
					// A later poll or close supersedes running hints, even if another call
					// returns an older partial result. Keep every call's output for recovery.
					for (const call of receipt.calls) {
						if (call.running && call.sessionId !== undefined && receipt.completedSessions.has(call.sessionId)) {
							call.running = false;
							call.summary = undefined;
						}
					}
					const fullPath = (result.details as CodemodeToolDetails | undefined)?.fullOutputPath;
					const tracked = new Set(receipt.calls.map(call => call.name));
					let footer = "";
					const content = result.content.map(item => {
						if (item.type !== "text") return item;
						if (fullPath) item = { ...item, text: alignTruncation(item.text) };
						if (!result.isError) return item;
						const end = fullPath ? item.text.lastIndexOf(`\n\n[Full output: ${fullPath} (`) : -1;
						if (end >= 0) {
							footer = item.text.slice(end);
							item = { ...item, text: item.text.slice(0, end) };
						}
						const start = item.text.lastIndexOf("Script error:\n");
						if (start < 0) return item;
						const error = item.text.slice(start).replace(/\n\n(Tool calls made before the failure \(they are not undone\): )([^\n]*)/, (_line, label, calls: string) => {
							const other = calls.split(", ").filter(call => !tracked.has(call.split(" (")[0]));
							return other.length ? `\n\n${label}${other.join(", ")}` : "";
						});
						const missing = /TypeError: tools\.([\w$]+) does not exist\./.exec(error)?.[1];
						const matches = missing && ctx?.tools ? closestToolNames(missing, ctx.tools.map(tool => scriptIdentifier(tool.name))) : [];
						const diagnostic = scriptDiagnostic(input.code, error);
						const text = item.text.slice(0, start) + diagnostic;
						return { ...item, text: text
							+ (matches.length ? `\n\nTool interface: ${matches.map(name => `tools.${name}`).join(", ")}. Use describeTool for the arguments.` : "") };
					});
					const report = await nestedReport(receipt.calls, !!result.isError, content.filter(item => item.type === "text").map(item => item.text).join("\n"));
					if (report) content.push({ type: "text", text: report });
					if (footer) content.filter(item => item.type === "text").at(-1)!.text += footer;
					return { ...result, content };
				},
			});
		},
	});
	pi.registerToolRenderer((name, next) => {
		const renderers = next();
		const renderResult = renderers?.renderResult;
		if (name !== "codemode" || !renderResult) return renderers;
		return {
			...renderers,
			renderResult(result, options, theme, context) {
				const details = result.details as CodemodeToolDetails | undefined;
				const calls = details?.calls?.map(call => formatTerminalCall(call, theme));
				const content = options.isPartial ? result.content : result.content.map(item => {
					if (item.type !== "text") return item;
					return { ...item, text: formatOutput(item.text, theme) };
				});
				return renderResult({ ...result, content, details: calls ? { ...details, calls } : details }, options, theme, context);
			},
		};
	});
}
