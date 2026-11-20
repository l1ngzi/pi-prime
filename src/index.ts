import { getReadmePath, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import modelSelector from "./model-selector.ts";
import codemode from "./codemode.ts";
import edit from "./edit.ts";
import read from "./read.ts";
import write from "./write.ts";
import tps from "./tps.ts";
import toolSearch from "./tool-search.ts";
import openRouter from "./openrouter.ts";
import toolResultContent from "./tool-result-content.ts";
import sessionRecall from "./session-recall.ts";
import terminal from "./terminal/index.ts";
import executionResources from "./execution-resources.ts";

const PROMPT_GUIDELINES = [
	"Deliver the intended result in the form the request, history, and project instructions call for, and complete the implied steps within scope. Preserve user work, keep secrets out of commits and shared outputs, and push, publish, send, or make destructive changes only as authorized.",
	"Start with the evidence at hand. When uncertainty could change the answer or next action, seek the observation or calculation that distinguishes plausible alternatives. If new attempts stop narrowing the uncertainty, step back and test a competing explanation.",
	"Check the final result where it will be used, including any exact form or governing spec the request relies on. For code changes, trace behavior to its source, exercise the normal entry point, and carry intended contract changes through affected callers and tests. Report observed results and any uncertainty that affects use.",
];

export default async function piPrime(pi: ExtensionAPI): Promise<void> {
	pi.on("before_agent_start", ({ systemPromptOptions }) => {
		systemPromptOptions.promptGuidelines.push(...PROMPT_GUIDELINES);
		systemPromptOptions.sections.docs ??= `Pi documentation (read only when asked about the pi harness itself): ${getReadmePath()}`;
	});
	modelSelector(pi);
	sessionRecall(pi);
	await openRouter(pi).catch(error => {
		console.warn("[pi-prime] OpenRouter transport enhancements could not initialize. Pi's provider remains available:", error);
	});
	tps(pi);
	toolSearch(pi);
	codemode(pi);
	read(pi);
	edit(pi);
	write(pi);
	toolResultContent(pi);
	terminal(pi);
	executionResources(pi);
}
