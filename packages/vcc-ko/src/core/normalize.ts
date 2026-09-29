import { asBashExecution, type CompactionMessage, type NormalizedBlock, type SourceRef } from "../types.ts";
import { textOf } from "./content.ts";
import { sanitize } from "./sanitize.ts";

const normalizeOne = (msg: CompactionMessage, msgIndex: SourceRef | undefined): NormalizedBlock[] => {
	if (msg.role === "custom") {
		return [
			{
				kind: "custom",
				customType: msg.customType,
				text: sanitize(textOf(msg.content)),
				...(msg.display === false && { display: false }),
				sourceIndex: msgIndex,
			},
		];
	}
	if (msg.role === "branchSummary" || msg.role === "compactionSummary") {
		return [
			{
				kind: "custom",
				customType: msg.role,
				text: sanitize(msg.summary),
				sourceIndex: msgIndex,
			},
		];
	}
	if (msg.role === "user") {
		const blocks: NormalizedBlock[] = [];
		const text = sanitize(textOf(msg.content));
		if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex });
		if (msg.content && typeof msg.content !== "string") {
			for (const part of msg.content) {
				if (part.type === "image") {
					blocks.push({
						kind: "user",
						text: `[image: ${part.mimeType}]`,
						sourceIndex: msgIndex,
					});
				}
			}
		}
		return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
	}

	const bash = asBashExecution(msg);
	if (bash) {
		if (bash.excludeFromContext) return [];
		const cmd = bash.command ?? "";
		const out = bash.output ?? "";
		const exit = bash.exitCode;
		return [
			{
				kind: "bash",
				command: cmd,
				output: out,
				exitCode: exit,
				sourceIndex: msgIndex,
			},
		];
	}

	if (msg.role === "toolResult") {
		return [
			{
				kind: "tool_result",
				name: msg.toolName,
				text: sanitize(textOf(msg.content)),
				...(typeof msg.toolCallId === "string" && { toolCallId: msg.toolCallId }),
				sourceIndex: msgIndex,
			},
		];
	}

	if (msg.role === "assistant") {
		if (!msg.content) return [];
		if (typeof msg.content === "string") {
			return [
				{
					kind: "assistant",
					text: sanitize(msg.content),
					sourceIndex: msgIndex,
				},
			];
		}

		const blocks: NormalizedBlock[] = [];
		for (const part of msg.content) {
			if (part.type === "text") {
				blocks.push({
					kind: "assistant",
					text: sanitize(part.text),
					sourceIndex: msgIndex,
				});
			} else if (part.type === "toolCall") {
				blocks.push({
					kind: "tool_call",
					name: part.name,
					args: part.arguments,
					...(typeof part.id === "string" && { id: part.id }),
					sourceIndex: msgIndex,
				});
			}
		}
		return blocks;
	}

	return [];
};

/**
 * Normalize messages to blocks. `sourceIndices`, when provided, supplies the
 * session-global `#N` index per input position (see src/core/global-indices.ts).
 * A missing entry yields `sourceIndex: undefined`, which downstream renderers
 * display as no ref — never a window-relative number. Omitted entirely, the
 * legacy positional behavior is preserved (used by callers/tests that have no
 * index space to map into).
 */
export const normalize = (
	messages: CompactionMessage[],
	sourceIndices?: Array<SourceRef | undefined>,
): NormalizedBlock[] => messages.flatMap((msg, i) => normalizeOne(msg, sourceIndices ? sourceIndices[i] : i));
