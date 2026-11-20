import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels, type Model, type Api, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CustomEditor, DynamicBorder, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

interface Preferences { favorites: string[]; order: string[]; thinking?: Record<string, ModelThinkingLevel> }
type Item = { key: string; model: Model<Api> } | { key: string; provider: string };
const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

function readPreferences(): Preferences {
	const path = join(getAgentDir(), "pi-prime-models.json");
	if (!existsSync(path)) return { favorites: [], order: [] };
	const data = JSON.parse(readFileSync(path, "utf8"));
	const strings = (value: unknown): string[] => {
		if (value === undefined) return [];
		if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`Invalid preferences: ${path}`);
		return [...new Set(value)] as string[];
	};
	if (data.thinking !== undefined && (!data.thinking || typeof data.thinking !== "object" || Array.isArray(data.thinking)
		|| Object.values(data.thinking).some(level => typeof level !== "string"))) throw new Error(`Invalid preferences: ${path}`);
	return { favorites: strings(data.favorites), order: strings(data.order), ...(data.thinking ? { thinking: data.thinking } : {}) };
}

function savePreferences(data: Preferences) {
	const path = join(getAgentDir(), "pi-prime-models.json");
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		renameSync(temp, path);
	} finally { rmSync(temp, { force: true }); }
}

export default function (pi: ExtensionAPI) {
	let open = false;
	let restoreEditor: (() => void) | undefined;
	async function show(ctx: ExtensionContext) {
		if (open) return;
		open = true;
		const refresh = new AbortController();
		try {
			let preferences = readPreferences();
			const registry = ctx.modelRegistry;
			const getModels = () => ctx.scopedModels.length
				? ctx.scopedModels.map(({ model }) => registry.find?.(model.provider, model.id) ?? model)
				: registry.getAvailable();
			let models = getModels();
			const selected = await ctx.ui.custom<{ model: Model<Api>; thinking?: ModelThinkingLevel; saveDefault: boolean } | undefined>((tui, theme, kb, done) => {
				const input = new Input();
				const border = new DynamicBorder(text => theme.fg("border", text));
				let provider: string | undefined;
				let rootQuery = "";
				let items: Item[] = [];
				let index = 0;
				let start = 0;
				let rows = new Map<number, Item>();
				let error = "";
				let editingThinking = false;
				let focused = false;
				const isFavorite = (item: Item) => "model" in item && preferences.favorites.includes(item.key);
				const thinking = (model: Model<Api>) => clampThinkingLevel(model, preferences.thinking?.[modelKey(model)] ?? ctx.thinkingLevel ?? "off");
				let drag: { source: Item; target: Item; start: number } | undefined;

				function ordered() {
					const ranks = new Map(preferences.order.map((key, i) => [key, i]));
					return [...models].sort((a, b) => (ranks.get(modelKey(a)) ?? Infinity) - (ranks.get(modelKey(b)) ?? Infinity)
						|| a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
				}
				function filter(keep?: string) {
					const query = input.getValue().trim();
					const available = ordered().filter(model => provider ? model.provider === provider : !!query || preferences.favorites.includes(modelKey(model)));
					let matches = fuzzyFilter(available, query, model => `${modelKey(model)} ${model.name}`);
					if (provider && query) {
						const matching = new Set(matches);
						matches = available.filter(model => matching.has(model));
					}
					items = matches.map(model => ({ key: modelKey(model), model }));
					if (!provider) {
						const providers = [...new Set(models.map(model => model.provider))].sort();
						items.push(...fuzzyFilter(providers, query, name => name).map(name => ({ key: `provider:${name}`, provider: name })));
					}
					index = keep ? Math.max(0, items.findIndex(item => item.key === keep)) : 0;
				}
				function change(update: (data: Preferences) => void, keep: string) {
					try {
						const next = readPreferences();
						update(next);
						savePreferences(next);
						preferences = next;
						error = "";
					} catch (cause) { error = `Could not save: ${cause instanceof Error ? cause.message : String(cause)}`; return false; }
					filter(keep);
					return true;
				}
				function move(source: Item, target: Item) {
					if (!("model" in source) || !("model" in target) || source.key === target.key) return;
					const keys = ordered().map(modelKey);
					const from = keys.indexOf(source.key), to = keys.indexOf(target.key);
					keys.splice(from, 1);
					keys.splice(to, 0, source.key);
					change(data => { data.order = [...keys, ...data.order.filter(key => !keys.includes(key))]; }, source.key);
				}
				const finish = (value: { model: Model<Api>; thinking?: ModelThinkingLevel; saveDefault: boolean } | undefined) => {
					refresh.abort();
					done(value);
				};
				function activate(saveDefault = false) {
					const item = items[index];
					if (!item || (saveDefault && !("model" in item))) return;
					if ("model" in item) {
						const level = isFavorite(item) ? thinking(item.model) : undefined;
						if (level !== undefined && preferences.thinking?.[item.key] !== level) {
							if (!change(data => { data.thinking = { ...data.thinking, [item.key]: level }; }, item.key)) return;
						}
						finish({ model: item.model, thinking: level, saveDefault });
					} else { rootQuery = input.getValue(); provider = item.provider; input.setValue(""); filter(); }
				}
				function back() {
					if (editingThinking) { editingThinking = false; input.focused = focused; return; }
					if (!provider) { finish(undefined); return; }
					const key = `provider:${provider}`;
					provider = undefined;
					input.setValue(rootQuery);
					filter(key);
				}
				filter();
				async function refreshModels() {
					if (!registry.refresh) return;
					try { await registry.refresh({ signal: refresh.signal }); }
					catch { return; } // The cached list stays usable offline.
					if (refresh.signal.aborted) return;
					const keep = items[index]?.key;
					models = getModels();
					filter(keep);
					drag = undefined;
					if (editingThinking && keep !== items[index]?.key) { editingThinking = false; input.focused = focused; }
					tui.requestRender();
				}
				void refreshModels();
				const component: Component & { focused: boolean; dispose(): void } = {
					dispose() { refresh.abort(); },
					get focused() { return focused; },
					set focused(value) { focused = value; input.focused = value && !editingThinking; },
					invalidate() { input.invalidate(); border.invalidate(); },
					render(width) {
						const lines = [...border.render(width), ""];
						if (provider) lines.push(theme.fg("muted", provider));
						lines.push(...input.render(width), "");
						const maxVisible = Math.max(1, Math.min(10, tui.terminal.rows - 12));
						start = drag?.start ?? Math.max(0, Math.min(index - Math.floor(maxVisible / 2), items.length - maxVisible));
						rows = new Map();
						let section = "";
						const modelSection = input.getValue().trim() ? "Models" : "Favorites";
						const labelWidth = Math.min(Math.max(0, width - 11), Math.max(0, ...items.map(item => "model" in item ? visibleWidth(`${item.model.id} [${item.model.provider}]`) + 2 : 0)));
						for (let i = start; i < Math.min(start + maxVisible, items.length); i++) {
							const item = items[i];
							if (!provider) {
								const next = "provider" in item ? "Providers" : modelSection;
								if (section !== next) { lines.push(theme.fg("muted", next)); section = next; }
							}
							const cursor = i === index ? "→ " : "  ";
							const current = ctx.model && ("model" in item ? modelKey(ctx.model) === item.key : ctx.model.provider === item.provider);
							const label = "model" in item ? `${item.model.id} [${item.model.provider}]` : item.provider;
							let text = cursor + label;
							let suffix = "";
							if ("model" in item && isFavorite(item)) {
								text = truncateToWidth(text, labelWidth);
								suffix = " ".repeat(Math.max(1, labelWidth - visibleWidth(text) + 2)) + theme.fg(i === index && editingThinking ? "accent" : "muted", `${i === index && editingThinking ? "[" : ""}${thinking(item.model)}${i === index && editingThinking ? "]" : ""}`);
							}
							rows.set(lines.length, item);
							lines.push(theme.fg(current ? "success" : i === index || drag?.target.key === item.key ? "accent" : "text", text) + suffix);
						}
						if (!items.length) lines.push(theme.fg("muted", "  No matching models"));
						if (items.length > maxVisible) lines.push(theme.fg("muted", `  (${index + 1}/${items.length})`));
						if (error) lines.push(theme.fg("error", error));
						const saveKeys = kb.getKeys("app.models.save").join("/").replace(/\b\w/g, letter => letter.toUpperCase());
						const saveHint = saveKeys && items[index] && "model" in items[index] ? ` · ${saveKeys} default` : "";
						lines.push("", theme.fg("dim", editingThinking ? `↑↓ thinking · ← model · Enter select${saveHint} · Esc back` : `Enter select${saveHint} · Esc ${provider ? "back" : "cancel"} · Ctrl+D favorite${items[index] && isFavorite(items[index]) ? " · → thinking" : ""}`), ...border.render(width));
						return lines.map(line => truncateToWidth(line, width));
					},
					handleInput(data) {
						if (drag) { if (kb.matches(data, "tui.select.cancel")) drag = undefined; else return; }
						if (kb.matches(data, "tui.select.cancel")) back();
						else if (kb.matches(data, "tui.select.confirm")) activate();
						else if (kb.matches(data, "app.models.save")) activate(true);
						else if (kb.matches(data, "tui.input.tab")) {
							editingThinking = false; input.focused = focused; index = 0;
						} else if (matchesKey(data, Key.right) && items[index] && isFavorite(items[index])) {
							editingThinking = true; input.focused = false;
						} else if (editingThinking && matchesKey(data, Key.left)) {
							editingThinking = false; input.focused = focused;
						} else if (editingThinking) {
							const item = items[index];
							if (item && "model" in item && (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down"))) {
								const levels = getSupportedThinkingLevels(item.model);
								const next = Math.max(0, Math.min(levels.length - 1, levels.indexOf(thinking(item.model)) + (kb.matches(data, "tui.select.up") ? 1 : -1)));
								if (levels[next] && levels[next] !== thinking(item.model)) change(data => { data.thinking = { ...data.thinking, [item.key]: levels[next] }; }, item.key);
							}
						} else if (matchesKey(data, Key.ctrl("d"))) {
							const item = items[index];
							if (item && "model" in item) change(data => {
								if (data.favorites.includes(item.key)) data.favorites = data.favorites.filter(key => key !== item.key);
								else {
									data.favorites.push(item.key);
									data.thinking = { ...data.thinking, [item.key]: thinking(item.model) };
								}
							}, item.key);
						} else if (matchesKey(data, Key.alt("up")) || matchesKey(data, Key.alt("down"))) {
							const target = index + (matchesKey(data, Key.alt("up")) ? -1 : 1);
							if (items[index] && items[target]) move(items[index], items[target]);
						} else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
							if (items.length) index = (index + (kb.matches(data, "tui.select.up") ? -1 : 1) + items.length) % items.length;
						} else {
							const query = input.getValue();
							input.handleInput(data);
							if (input.getValue() !== query) filter();
						}
						tui.requestRender();
					},
					handleMouse(event) {
						if (drag) {
							if (event.type === "drag") {
								const target = rows.get(event.y);
								if (target && "model" in target) drag.target = target;
								return { handled: true, render: true };
							}
							if (event.type === "release") { const { source, target } = drag; drag = undefined; move(source, target); return { handled: true, render: true }; }
							return { handled: true };
						}
						if (event.type === "wheel") {
							editingThinking = false; input.focused = focused;
							index = Math.max(0, Math.min(items.length - 1, index + (event.wheelDelta ?? 0)));
							return { handled: true, render: true };
						}
						const item = rows.get(event.y);
						if (!item || event.button !== "left") return undefined;
						if (event.type === "press") {
							editingThinking = false; input.focused = focused;
							index = items.indexOf(item);
							if ("model" in item) { drag = { source: item, target: item, start }; return { capture: true, focus: true }; }
							return { handled: true, focus: true };
						}
						if (event.type === "click") return { handled: true };
						return undefined;
					},
				};
				return component;
			});
			if (selected) {
				if (await pi.setModel(selected.model)) {
					if (selected.thinking !== undefined) pi.setThinkingLevel(selected.thinking);
					if (selected.saveDefault) {
						const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: false });
						settings.setDefaultModelAndProvider(selected.model.provider, selected.model.id);
						if (selected.thinking !== undefined) settings.setDefaultThinkingLevel(selected.thinking);
						await settings.flush();
						const [failure] = settings.drainErrors();
						if (failure) throw new Error(`Could not save default model: ${failure.error.message}`);
						ctx.ui.notify(`Default model: ${modelKey(selected.model)}`, "info");
					}
				} else ctx.ui.notify(`No authentication configured for ${selected.model.provider}.`, "error");
			}
		} catch (error) { ctx.ui.notify(`Model selector: ${error instanceof Error ? error.message : String(error)}`, "error"); }
		finally { refresh.abort(); open = false; }
	}
	pi.on("session_start", (_event, ctx) => {
		restoreEditor?.();
		if (ctx.mode !== "tui") return;
		const previousFactory = ctx.ui.getEditorComponent();
		const factory: NonNullable<typeof previousFactory> = (tui, theme, kb) => {
			const editor = previousFactory ? previousFactory(tui, theme, kb) : new CustomEditor(tui, theme, kb, { embedWorkingStatus: true });
			const handleInput = editor.handleInput;
			editor.handleInput = (data: string) => {
				if (kb.matches(data, "app.model.select")) { void show(ctx); return; }
				// Inspect the final command after autocomplete. Pi replaces onSubmit between prompts,
				// so wrap it only for the duration of this input event.
				const onSubmit = editor.onSubmit;
				const wrappedSubmit = (text: string) => {
					if (text.trim() === "/model") void show(ctx);
					else onSubmit?.call(editor, text);
				};
				editor.onSubmit = wrappedSubmit;
				try { handleInput.call(editor, data); }
				finally { if (editor.onSubmit === wrappedSubmit) editor.onSubmit = onSubmit; }
			};
			return editor;
		};
		ctx.ui.setEditorComponent(factory);
		restoreEditor = () => { if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previousFactory); };
	});
	pi.on("session_shutdown", () => { restoreEditor?.(); restoreEditor = undefined; });
}
