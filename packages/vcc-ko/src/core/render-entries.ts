import type { Message } from "@earendil-works/pi-ai";
import { asBashExecution } from "../types.ts";
import { clip, textOf } from "./content.ts";
import { customRef } from "./global-indices.ts";
import { extractPath, summarizeToolArgs } from "./tool-args.ts";

/**
 * A `custom_message` session entry (subagent results, background job
 * completions, ...) viewed as a message so recall can carry it through the
 * same rendered/raw pipeline as real messages. Pi's `Message` union does not
 * model it, so loaders cast at the boundary (see `load-messages.ts`).
 */
export interface CustomPseudoMessage {
	role: "custom";
	customType: string;
	content: string;
	display?: boolean;
}

export const asCustomPseudoMessage = (msg: unknown): CustomPseudoMessage | null =>
	typeof msg === "object" && msg !== null && (msg as CustomPseudoMessage).role === "custom"
		? (msg as CustomPseudoMessage)
		: null;

export interface RenderedEntry {
	/** Position in its own index space: `#N` for messages, `#cN` for customs. */
	index: number;
	/** Canonical ref token, always set: `"12"` for messages, `"c3"` for customs. */
	ref: string;
	role: string;
	/** Only for `role: "custom"` — the originating extension's customType. */
	customType?: string;
	summary: string;
	files?: string[];
}

const toolCalls = (content: Message["content"]): string => {
	if (!content || typeof content === "string") return "";
	return content
		.filter((c) => c.type === "toolCall")
		.map((c) => `${c.name}(${summarizeToolArgs(c.arguments)})`)
		.join(", ");
};

const extractFilesFromContent = (content: Message["content"]): string[] => {
	if (!content || typeof content === "string") return [];
	return content
		.filter((c) => c.type === "toolCall")
		.map((c) => extractPath(c.arguments))
		.filter((p): p is string => p !== null);
};

export const renderMessage = (msg: Message | CustomPseudoMessage, index: number, full = false): RenderedEntry => {
	// Custom pseudo messages live in the `#cN` space and read like user text.
	const custom = asCustomPseudoMessage(msg);
	if (custom) {
		const text = textOf(custom.content);
		return {
			index,
			ref: customRef(index),
			role: "custom",
			customType: custom.customType,
			summary: full ? text : clip(text, 300),
		};
	}
	if (msg.role === "user") {
		return {
			index,
			ref: String(index),
			role: "user",
			summary: full ? textOf(msg.content) : clip(textOf(msg.content), 300),
		};
	}
	if (msg.role === "toolResult") {
		const text = full ? textOf(msg.content) : clip(textOf(msg.content), 200);
		return {
			index,
			ref: String(index),
			role: "tool_result",
			summary: `[${msg.toolName}] ${text}`,
		};
	}
	// bashExecution has command+output instead of content
	const bash = asBashExecution(msg);
	if (bash) {
		const cmd = bash.command ?? "";
		const out = bash.output ?? "";
		const text = full ? `$ ${cmd}\n${out}` : clip(`$ ${cmd}\n${out}`, 300);
		return { index, ref: String(index), role: "bash", summary: text };
	}
	const text = full ? textOf(msg.content) : clip(textOf(msg.content), 300);
	const tools = toolCalls(msg.content);
	const files = extractFilesFromContent(msg.content);
	const summary = tools ? `${tools}\n${text}` : text;
	return {
		index,
		ref: String(index),
		role: "assistant",
		summary,
		...(files.length > 0 && { files }),
	};
};
