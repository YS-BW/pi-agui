import type { RunAgentInput, ToolMessage } from "@ag-ui/core";

/** Only the latest turn is submitted: Pi owns the conversation history. */
export function extractRunInput(input: RunAgentInput) {
	if (input.resume?.length) throw new Error("Native UI approvals use POST /ui/:requestId; resume is not supported");
	const last = input.messages.at(-1);
	if (last?.role === "tool") {
		const results: ToolMessage[] = [];
		for (let i = input.messages.length - 1; i >= 0 && input.messages[i]?.role === "tool"; i--) {
			results.unshift(input.messages[i] as ToolMessage);
		}
		return { text: "", images: [], results };
	}
	if (last?.role !== "user") throw new Error("The latest message must be a user message or frontend tool result");
	const images: { type: "image"; data: string; mimeType: string }[] = [];
	const texts: string[] = [];
	if (typeof last.content === "string") texts.push(last.content);
	else
		for (const part of last.content) {
			if (part.type === "text") texts.push(part.text);
			else if (part.type === "image" && part.source.type === "data") {
				images.push({
					type: "image",
					data: part.source.value,
					mimeType: part.source.mimeType ?? "image/png",
				});
			} else throw new Error(`Unsupported input part: ${part.type}. Images must use inline data.`);
		}
	const text = texts.join("\n");
	if (!text.trim() && !images.length) throw new Error("没有收到任何用户文本或图片");
	return { text, images, results: [] as ToolMessage[] };
}

export function buildContext(input: Partial<RunAgentInput> | undefined, state: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const message of input?.messages ?? []) {
		if (message.role === "system" || message.role === "developer") parts.push(message.content);
	}
	if (input?.context?.length) parts.push("Application context:\n" + input.context.map((c) => `${c.description}: ${c.value}`).join("\n"));
	parts.push("Current shared UI state (use ag_ui_update_state to update it):\n" + JSON.stringify(state));
	return parts.join("\n\n");
}

/** Convert AG-UI tool-result content into Pi's text/image tool-result content. */
export function toPiToolResultContent(content: ToolMessage["content"]) {
	if (typeof content === "string") return [{ type: "text" as const, text: content }];
	return content.map((part) => {
		if (part.type === "text") return { type: "text" as const, text: part.text };
		if (part.type === "image" && part.source.type === "data") {
			return {
				type: "image" as const,
				data: part.source.value,
				mimeType: part.source.mimeType,
			};
		}
		return { type: "text" as const, text: JSON.stringify(part) };
	});
}
