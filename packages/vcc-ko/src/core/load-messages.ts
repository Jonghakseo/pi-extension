import type { Message } from "@earendil-works/pi-ai";
import { RECALL_OUTPUT_CUSTOM_TYPE } from "../types.ts";
import { textOf } from "./content.ts";
import { isCountedCustomEntry, isCountedMessageEntry } from "./global-indices.ts";
import { forEachJsonlLine } from "./jsonl.ts";
import { type CustomPseudoMessage, type RenderedEntry, renderMessage } from "./render-entries.ts";

export interface LoadedMessages {
	rendered: RenderedEntry[];
	rawMessages: Message[];
}

export interface LoadOptions {
	/**
	 * Interleave `custom_message` entries (subagent results, background job
	 * completions, ...) into the result under the `#cN` ref space. Off by
	 * default so message-only callers (drill-down, mode:'touched', the
	 * compaction paths) keep seeing exactly the entries they always saw.
	 */
	includeCustom?: boolean;
}

/**
 * Roles recall can filter on. `custom` only appears with `includeCustom`.
 */
export type LoadedRole = "user" | "assistant" | "tool_result" | "bash" | "custom";

/**
 * Pi 0.87 persists the system prompt as a `role:"system"` message whose
 * `content` is usually empty (the prompt itself lives in `sections`). It is
 * still counted in the `#N` space — existing summaries reference those
 * numbers — but rendering it produced a bogus `#0 [assistant]` with an empty
 * body in every recall listing.
 */
const isSystemMessage = (message: any): boolean => message?.role === "system";

export const loadAllMessages = (
	sessionFile: string,
	full: boolean,
	allowedEntryIds?: Set<string>,
	options?: LoadOptions,
): LoadedMessages => {
	const rendered: RenderedEntry[] = [];
	const rawMessages: Message[] = [];
	const includeCustom = options?.includeCustom ?? false;
	let messageIndex = 0;
	let customIndex = 0;

	const processLine = (line: Buffer) => {
		if (line.length === 0) return;
		let entry: any;
		try {
			entry = JSON.parse(line.toString("utf8"));
		} catch {
			return;
		}
		// Counting rule shared with src/core/global-indices.ts — both index
		// spaces must agree by construction. Every counted entry advances its
		// counter even when it is filtered out or skipped from the output, so a
		// `#N` / `#cN` ref always means the same entry.
		if (isCountedMessageEntry(entry)) {
			const allowed = !allowedEntryIds || allowedEntryIds.has(entry.id);
			if (allowed && !isSystemMessage(entry.message)) {
				rendered.push(renderMessage(entry.message, messageIndex, full));
				rawMessages.push(entry.message);
			}
			messageIndex++;
			return;
		}
		if (isCountedCustomEntry(entry)) {
			const index = customIndex++;
			if (!includeCustom) return;
			// The command's own output (still counted, so #cN stays aligned).
			if (entry.customType === RECALL_OUTPUT_CUSTOM_TYPE) return;
			if (allowedEntryIds && !allowedEntryIds.has(entry.id)) return;
			const text = textOf(entry.content);
			if (text.trim().length === 0) return;
			const pseudo: CustomPseudoMessage = {
				role: "custom",
				customType: typeof entry.customType === "string" ? entry.customType : "custom",
				content: text,
				display: entry.display,
			};
			rendered.push(renderMessage(pseudo, index, full));
			// Pi's Message union does not model custom entries; the cast keeps the
			// rendered/raw arrays parallel for search and touched-file mapping.
			rawMessages.push(pseudo as unknown as Message);
		}
	};

	// Streamed via forEachJsonlLine: large sessions can exceed V8's maximum
	// string length before parsing even starts. A missing file yields an empty
	// result — Pi does not create a new session's JSONL until its first
	// persisted entry.
	forEachJsonlLine(sessionFile, processLine);

	return { rendered, rawMessages };
};

/**
 * Keep only entries of one role, preserving the rendered/raw pairing.
 * `role` undefined is a no-op, so call sites can pass an unvalidated option
 * straight through.
 */
export const filterLoadedByRole = (loaded: LoadedMessages, role?: LoadedRole): LoadedMessages => {
	if (!role) return loaded;
	const rendered: RenderedEntry[] = [];
	const rawMessages: Message[] = [];
	for (let i = 0; i < loaded.rendered.length; i++) {
		if (loaded.rendered[i].role !== role) continue;
		rendered.push(loaded.rendered[i]);
		rawMessages.push(loaded.rawMessages[i]);
	}
	return { rendered, rawMessages };
};

/**
 * Drop entries whose rendered body is empty. Browse listings would otherwise
 * spend slots on entries an agent can learn nothing from (an assistant turn
 * that only made a tool call it already sees elsewhere, for instance). Search
 * needs no equivalent: an empty body cannot match a query.
 */
export const withNonEmptySummary = (entries: RenderedEntry[]): RenderedEntry[] =>
	entries.filter((e) => e.summary.trim().length > 0);
