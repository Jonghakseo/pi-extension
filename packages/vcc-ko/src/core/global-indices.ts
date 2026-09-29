/**
 * Session-global recall refs — the single definition of the `#N` / `#cN` index spaces.
 *
 * Recall (`src/core/load-messages.ts`) numbers every `type == "message"` entry
 * in session-file order, counting across compaction windows and abandoned
 * branches. Compaction summaries must emit the same numbers, but `normalize`
 * historically numbered the selected window from zero. This module owns the
 * counting rule so both sides agree by construction.
 *
 * Extension-injected `custom_message` entries (subagent results, async job
 * completions, ...) live in a SEPARATE space, `#cN`, counted the same way
 * among custom_message entries only. A separate space keeps every existing
 * `#N` ref (already persisted in older summaries) pointing at the same message.
 *
 * Ported from k0valik/pi-blackhole commit f82e07a (issue #28); the file
 * fallback streams via forEachJsonlLine instead of readFileSync so giant
 * sessions stay within PR #26's memory bounds.
 */
import { forEachJsonlLine } from "./jsonl.ts";

/** Entries counted by the global `#N` index: persisted message entries. */
export const isCountedMessageEntry = (entry: any): boolean => entry?.type === "message" && entry.message != null;

/** Entries counted by the separate `#cN` index: extension-injected custom messages. */
export const isCountedCustomEntry = (entry: any): boolean => entry?.type === "custom_message";

export const CUSTOM_REF_PREFIX = "c";

/** Ref token for the n-th custom_message entry (without the leading `#`). */
export const customRef = (n: number): string => `${CUSTOM_REF_PREFIX}${n}`;

export type RecallRef = { kind: "message"; index: number } | { kind: "custom"; index: number };

const REF_RE = /^#?(c)?(\d+)$/i;

/**
 * Parse a ref supplied by a model or user: `12`, `"12"`, `"#12"`, `"c3"`, `"#c3"`.
 * Returns null for anything else (negative, fractional, malformed).
 */
export const parseRecallRef = (raw: unknown): RecallRef | null => {
	if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? { kind: "message", index: raw } : null;
	if (typeof raw !== "string") return null;
	const m = REF_RE.exec(raw.trim());
	if (!m) return null;
	const index = Number(m[2]);
	if (!Number.isSafeInteger(index)) return null;
	return m[1] ? { kind: "custom", index } : { kind: "message", index };
};

/** Canonical display token for a ref, without the leading `#`: `12` or `c3`. */
export const formatRecallRef = (ref: RecallRef): string =>
	ref.kind === "custom" ? customRef(ref.index) : String(ref.index);

/**
 * Accumulates the id → ref mapping one entry at a time so both the in-memory
 * array path and the streaming file path share one counting rule.
 *
 * Entries without a usable id are still counted (they occupy an index) but
 * produce no map entry. Duplicate ids are ambiguous — dropped fail-closed so
 * callers emit no ref instead of a wrong one.
 */
const createGlobalRefBuilder = () => {
	const byId = new Map<string, RecallRef>();
	const ambiguous = new Set<string>();
	let messageIndex = 0;
	let customIndex = 0;
	return {
		add(entry: any) {
			let ref: RecallRef;
			if (isCountedMessageEntry(entry)) ref = { kind: "message", index: messageIndex++ };
			else if (isCountedCustomEntry(entry)) ref = { kind: "custom", index: customIndex++ };
			else return;
			const id = entry?.id;
			if (typeof id !== "string" || id.length === 0) return;
			if (byId.has(id) || ambiguous.has(id)) {
				byId.delete(id);
				ambiguous.add(id);
				return;
			}
			byId.set(id, ref);
		},
		map: () => byId,
	};
};

/**
 * Map session entry ids to their recall ref (message `#N` or custom `#cN`),
 * counting in array order, which matches session-file order.
 */
export const buildGlobalRefById = (entries: readonly any[]): Map<string, RecallRef> => {
	const b = createGlobalRefBuilder();
	for (const entry of entries) b.add(entry);
	return b.map();
};

/**
 * Build the same map by streaming a session JSONL file. Malformed lines are
 * skipped silently (load-messages already skips them). Returns undefined when
 * the file cannot be read (missing or IO error).
 */
export const loadGlobalRefById = (sessionFile: string): Map<string, RecallRef> | undefined => {
	const b = createGlobalRefBuilder();
	let ok: boolean;
	try {
		ok = forEachJsonlLine(sessionFile, (line) => {
			if (line.length === 0) return;
			try {
				b.add(JSON.parse(line.toString("utf8")));
			} catch {
				// Corrupt lines are silently dropped by pi too.
			}
		});
	} catch {
		return undefined;
	}
	return ok ? b.map() : undefined;
};

const messageIndicesOnly = (refs: Map<string, RecallRef>): Map<string, number> => {
	const out = new Map<string, number>();
	for (const [id, ref] of refs) if (ref.kind === "message") out.set(id, ref.index);
	return out;
};

/** Message-only view (`#N`), kept for callers that predate the `#cN` space. */
export const buildGlobalIndexById = (entries: readonly any[]): Map<string, number> =>
	messageIndicesOnly(buildGlobalRefById(entries));

/** Message-only view (`#N`) streamed from a session file. */
export const loadGlobalIndexById = (sessionFile: string): Map<string, number> | undefined => {
	const refs = loadGlobalRefById(sessionFile);
	return refs ? messageIndicesOnly(refs) : undefined;
};
