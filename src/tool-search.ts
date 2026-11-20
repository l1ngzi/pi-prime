import { createToolSearchExtension, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isDiscoverable, parseToolQuery, searchDescription } from "./tool-discovery.ts";
import { defaultToolOptions, isGptModel } from "./tool-mode.ts";

const description = "Find tools by capability. Results show the current entry point or load a matching tool for direct calls on the next turn. Pass a short capability query or exact tool names separated by spaces.";
const defaultLimit = 8;
const parameters = Type.Object({
	query: Type.String({ minLength: 1, description: "Capability to find, or exact tool names separated by spaces." }),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: `Maximum tools to return. Defaults to ${defaultLimit}.` })),
});

// Use Pi's ranker for natural language. Explicit names load only those tools, in
// query order, even when they are already active.
// Replaces Pi's built-in tool-search automatically; disable "-builtin:tool-search" to silence the startup notice.
export default function toolSearch(pi: ExtensionAPI): void {
	createToolSearchExtension()({
		...pi,
		// Let the bundled ranker see callable tools, including direct ones, without changing the live selection.
		getAllTools() {
			const active = new Set(pi.getActiveTools());
			return pi.getAllTools().filter(tool => isDiscoverable(tool) || (tool.exposure === "direct" && active.has(tool.name)))
				.map(tool => ({ ...tool, description: searchDescription(tool), exposure: "deferred" as const }));
		},
		getActiveTools: () => [],
		setActiveTools: () => {},
		registerTool(definition) {
			const tool = definition as unknown as ToolDefinition<typeof parameters>;
			pi.registerTool({
				...tool,
				...defaultToolOptions(),
				description,
				promptSnippet: "Find and load tools for direct calls",
				parameters,
				executionMode: "sequential",
				prepareLoadout(loadout) {
					if (!loadout.callable.some(tool => isDiscoverable({ exposure: loadout.getExposure(tool.name) }))) {
						return { hiddenDeclarations: [tool.name] };
					}
					return { descriptions: { [tool.name]: description + (loadout.declared.some(tool => tool.name === "codemode")
						? " For calls inside codemode, use searchTools(query) and describeTool(name)." : "") } };
				},
				async execute(...args) {
					const { query, limit = defaultLimit } = args[1];
					if (!query.trim() || !Number.isInteger(limit) || limit <= 0) return tool.execute(...args);
					const active = new Set(pi.getActiveTools());
					const registered = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
					const ctx = args[4];
					const scriptTools = active.has("codemode") && isGptModel(ctx?.model) ? new Set(ctx.tools.map(tool => tool.name)) : undefined;
					const route = (name: string) => {
						const info = registered.get(name);
						if (!info) return;
						if (isDiscoverable(info)) return "load";
						if (!active.has(name)) return;
						if (info.exposure === "model-only" || (!scriptTools && info.exposure === "direct")) return "direct";
						if (scriptTools?.has(name)) return "scripted";
					};
					const { names, explicit } = parseToolQuery(query, new Set(registered.keys()));
					const matches = explicit ? names.filter(route) : ((await tool.execute(...args)).details as { loaded: string[] }).loaded;
					const selected = matches.slice(0, limit);
					const added = selected.filter(name => !active.has(name) && route(name) === "load");
					if (added.length) pi.setActiveTools([...pi.getActiveTools(), ...added]);
					const available = new Set(pi.getActiveTools());
					const visible = selected.filter(name => available.has(name));
					const loaded: string[] = [];
					const lines: string[] = [];
					for (let i = 0; i < visible.length;) {
						const name = visible[i++], entry = route(name);
						if (entry === "load") {
							loaded.push(name);
							lines.push(`- ${name} (${active.has(name) ? "already loaded" : "available next turn"}): ${registered.get(name)!.description.trim().split(/\r?\n/)[0]}`);
						} else if (entry) {
							const group = [name];
							while (i < visible.length && route(visible[i]) === entry) group.push(visible[i++]);
							lines.push(entry === "direct" ? `Already available for direct calls: ${group.join(", ")}.`
								: `Available inside codemode: ${group.join(", ")}. Call tools.<name>(args) directly, or use describeTool(name) if unlisted.`);
						}
					}
					const unavailable = explicit ? names.filter(name => registered.has(name) && !route(name)) : [];
					const unmatched = explicit ? names.filter(name => !registered.has(name)) : [];
					if (unavailable.length) lines.push(`Unavailable through tool_search: ${unavailable.join(", ")}.`);
					if (unmatched.length) lines.push(`Unmatched names: ${unmatched.join(", ")}. Check the spelling or search for the capability separately.`);
					if (matches.length > limit) lines.push(`Showing ${limit} matches. Increase limit for more.`);
					return {
						content: [{
							type: "text",
							text: lines.length ? lines.join("\n") : "No matching tools found for this query. Try an exact tool name or describe the capability in a few words.",
						}],
						details: { loaded },
					};
				},
			});
		},
	});
}
