import { AgentSession, type CodemodeExtensionOptions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const primeDefault = Symbol.for("pi-prime.defaultActive");

// Pi 1.5.2 auto-activates extension tools after applying startup modifiers.
// The SDK keeps its per-session --tools modifiers here, outside ExtensionAPI.
type StartupSelection = Pick<AgentSession, "getToolDefinition" | "settingsManager"> & {
	_defaultToolModifiers?: string[];
	_isActivatedOnRegistration(name: string): boolean;
};

export function defaultToolOptions() {
	const proto = AgentSession?.prototype as unknown as StartupSelection | undefined;
	const activates = proto?._isActivatedOnRegistration;
	if (proto && typeof activates === "function" && !(primeDefault in activates)) {
		proto._isActivatedOnRegistration = Object.assign(function (this: StartupSelection, name: string) {
			if (!activates.call(this, name)) return false;
			const tool = this.getToolDefinition?.(name);
			if (!tool || !(primeDefault in tool)) return true;
			const defaults = this.settingsManager?.getSettings?.()?.defaultTools;
			const modifiers = [...(Array.isArray(defaults) ? defaults : []), ...(this._defaultToolModifiers ?? [])];
			return modifiers.lastIndexOf(`-${name}`) <= modifiers.lastIndexOf(`+${name}`);
		}, { [primeDefault]: true });
	}
	return { defaultActive: true, [primeDefault]: true };
}

// Identify the model, not its transport/provider: a proxy may serve either family.
export function isGptModel(model: { id: string } | undefined): boolean {
	return /^gpt-/i.test(model?.id.split("/").at(-1) ?? "");
}

/** Derive codemode's surface from the model and let Pi own the active selection. */
export function configureToolMode(pi: ExtensionAPI): CodemodeExtensionOptions {
	// Pi reads this object when preparing a loadout: "on" keeps native tools
	// alongside codemode, while "only" presents them inside codemode.
	const options: CodemodeExtensionOptions = { mode: "on" };
	const sync = (_event: unknown, ctx: ExtensionContext) => {
		const next = isGptModel(ctx.model) ? "only" : "on";
		if (next === options.mode) return;
		options.mode = next;
		pi.setActiveTools(pi.getActiveTools());
	};
	pi.on("session_start", sync);
	pi.on("session_tree", sync);
	pi.on("model_select", sync);
	pi.on("before_agent_start", sync);
	return options;
}
