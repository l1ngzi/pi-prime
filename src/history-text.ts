import { contentText, type ToolResultMessage } from "@earendil-works/pi-ai";

// Nested records contain call provenance, not the nested tools' full results.
// Share this representation between compaction and exact history retrieval.
export function toolResultText(message: ToolResultMessage): string {
	const nested = message.nestedCalls;
	return [
		`[${message.toolName}${message.isError ? "; error" : ""}]`,
		...(nested ? [
			`[nested calls${nested.complete ? "" : "; partial record"}]`,
			...nested.calls.map((call) => `${call.name}(${call.arguments === undefined ? "arguments omitted" : JSON.stringify(call.arguments)}) [${call.status}]${call.error ? ` ${call.error}` : ""}`),
		] : []),
		contentText(message.content, "\n"),
	].filter(Boolean).join("\n");
}
