/**
 * Task context snapshot.
 *
 * The parent agent hands a Task the conversation that led to it. `buildContextSnapshot` turns the
 * parent's active session branch into an immutable snapshot: a short brief for the child's first
 * prompt plus the original text of every carried entry, addressed by stable refs.
 *
 * The snapshot is the child's whole window into the parent conversation. It is captured once (and
 * again only when the parent explicitly edits/refreshes the Task), so anything the parent says
 * afterwards is invisible to the child until the next refresh. The child reads it through
 * `queryContext`, which never touches the parent session file, sibling sessions, or auth files.
 */

import type { ContextEntry, TaskContextSnapshot } from "../types.ts";

/** Maximum expanded page size. Original entries remain intact behind pagination. */
export const MAX_REF_PAGE_CHARS = 200_000;
export const MAX_BRIEF_CHARS = 4_000;
/** Chars of an entry returned per `refs` page. */
export const REF_PAGE_CHARS = 2_000;
export const SEARCH_PAGE_SIZE = 5;
export const SEARCH_SNIPPET_CHARS = 400;
const BRIEF_RECENT_USER_ENTRIES = 5;
const BRIEF_LINE_CHARS = 400;
const MAX_LISTING = 40;

// ── normalization ────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Obvious credential shapes, removed before anything reaches a child process. */
const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
	/("?(?:api[_-]?key|secret|password|token)"?\s*[:=]\s*)(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[^\s"',}]{8,})/gi,
];

export function redactSecrets(text: string): string {
	let output = text;
	for (const pattern of SECRET_PATTERNS) {
		output = output.replace(pattern, (_match, prefix?: string) =>
			typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]",
		);
	}
	return output;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		if (!isRecord(part)) continue;
		// Thinking blocks and raw images never travel to a child.
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part.type === "toolCall" && typeof part.name === "string") {
			const args = part.arguments === undefined ? "" : safeStringify(part.arguments);
			parts.push(`[tool call: ${part.name}]${args ? `\n${args}` : ""}`);
		}
	}
	return parts.join("\n");
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

interface NormalizedEntry {
	role: string;
	text: string;
	id?: string;
}

/** Entry kinds that carry conversation text. Everything else (usage, model_change, …) is dropped. */
function normalizeEntry(raw: unknown): NormalizedEntry | undefined {
	if (!isRecord(raw)) return undefined;
	const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : undefined;

	if (raw.type === "compaction") {
		const summary = typeof raw.summary === "string" ? raw.summary : "";
		return summary.trim() === "" ? undefined : { role: "compaction", text: summary, id };
	}

	if (raw.type === "custom_message") {
		const text = textFromContent(raw.content);
		if (text.trim() === "") return undefined;
		const label = typeof raw.customType === "string" && raw.customType !== "" ? raw.customType : "custom";
		return { role: `custom:${label}`, text, id };
	}

	if (raw.type === "message" || raw.role !== undefined) {
		const message = isRecord(raw.message) ? raw.message : raw;
		const role = typeof message.role === "string" ? message.role : "";
		if (role !== "user" && role !== "assistant" && role !== "toolResult") return undefined;
		const text = textFromContent(message.content);
		if (text.trim() === "") return undefined;
		if (role === "toolResult") {
			const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
			const failed = message.isError === true ? " (error)" : "";
			return { role: `toolResult:${toolName}${failed}`, text, id };
		}
		return { role, text, id };
	}

	return undefined;
}

function assignRefs(entries: readonly NormalizedEntry[]): ContextEntry[] {
	const used = new Set<string>();
	const result: ContextEntry[] = [];
	entries.forEach((entry, index) => {
		let ref = entry.id ?? `e${index + 1}`;
		if (used.has(ref)) ref = `${ref}#${index + 1}`;
		used.add(ref);
		result.push({ ref, role: entry.role, text: redactSecrets(entry.text) });
	});
	return result;
}

// ── brief ────────────────────────────────────────────────────────────────────

const oneLine = (text: string, max = BRIEF_LINE_CHARS): string => {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
};

/**
 * A compact brief: the newest compaction summary (the parent's own recap of everything before it),
 * the first user goal, and the most recent user instructions. Every line keeps its ref so the child
 * can pull the original text with `task_context`.
 */
export function buildBrief(entries: readonly ContextEntry[]): string {
	const lines: string[] = [];
	const userEntries = entries.filter((entry) => entry.role === "user");
	const compactions = entries.filter((entry) => entry.role === "compaction");
	const latestCompaction = compactions.at(-1);

	if (latestCompaction) {
		lines.push(`[${latestCompaction.ref}] earlier conversation summary: ${oneLine(latestCompaction.text, 1_200)}`);
	}

	const compactionIndex = latestCompaction ? entries.indexOf(latestCompaction) : -1;
	const firstGoal = userEntries[0];
	if (firstGoal && entries.indexOf(firstGoal) > compactionIndex) {
		lines.push(`[${firstGoal.ref}] first user goal: ${oneLine(firstGoal.text)}`);
	} else if (firstGoal) {
		lines.push(`[${firstGoal.ref}] first user goal (before the summary): ${oneLine(firstGoal.text)}`);
	}

	const recent = userEntries.slice(-BRIEF_RECENT_USER_ENTRIES).filter((entry) => entry !== firstGoal);
	for (const entry of recent) {
		lines.push(`[${entry.ref}] user: ${oneLine(entry.text)}`);
	}

	const lastAssistant = [...entries].reverse().find((entry) => entry.role === "assistant");
	if (lastAssistant) lines.push(`[${lastAssistant.ref}] latest assistant reply: ${oneLine(lastAssistant.text)}`);

	const brief = lines.join("\n");
	if (brief.length <= MAX_BRIEF_CHARS) return brief;
	return `${brief.slice(0, MAX_BRIEF_CHARS)}\n…[brief truncated; use task_context to read entries]`;
}

/** Build the immutable snapshot from the parent's active-branch session entries. */
export function buildContextSnapshot(entries: readonly unknown[]): TaskContextSnapshot {
	const normalized: NormalizedEntry[] = [];
	if (Array.isArray(entries)) {
		for (const raw of entries) {
			const entry = normalizeEntry(raw);
			if (entry) normalized.push(entry);
		}
	}
	const contextEntries = assignRefs(normalized);
	return { brief: buildBrief(contextEntries), entries: contextEntries };
}

// ── query ────────────────────────────────────────────────────────────────────

export interface QueryContextInput {
	query?: string;
	refs?: string[];
	offset?: number;
	limit?: number;
}

const toInt = (value: unknown, fallback: number, min: number, max: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
};

function safeEntries(snapshot: TaskContextSnapshot | undefined): ContextEntry[] {
	if (!snapshot || !Array.isArray(snapshot.entries)) return [];
	return snapshot.entries.filter(
		(entry): entry is ContextEntry =>
			isRecord(entry) && typeof entry.ref === "string" && typeof entry.text === "string",
	);
}

function renderRef(entry: ContextEntry, offset: number, limit: number): string {
	const total = entry.text.length;
	const start = Math.min(offset, total);
	const end = Math.min(start + limit, total);
	const slice = entry.text.slice(start, end);
	const header = `[${entry.ref}] ${entry.role}, chars ${start}-${end} of ${total}`;
	const footer =
		end < total
			? `\n…[more] next: task_context refs=["${entry.ref}"] offset=${end}`
			: total === 0
				? ""
				: "\n[end of entry]";
	return `${header}\n${slice}${footer}`;
}

function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}_.#/-]+/u)
		.filter((token) => token.length > 1);
}

function snippetAround(text: string, index: number): string {
	const start = Math.max(0, index - Math.floor(SEARCH_SNIPPET_CHARS / 3));
	const end = Math.min(text.length, start + SEARCH_SNIPPET_CHARS);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${text.slice(start, end)}${suffix}`;
}

interface ScoredEntry {
	entry: ContextEntry;
	score: number;
	firstMatch: number;
}

function scoreEntries(entries: readonly ContextEntry[], query: string): ScoredEntry[] {
	const tokens = tokenize(query);
	const literal = query.trim().toLowerCase();
	const scored: ScoredEntry[] = [];

	entries.forEach((entry, index) => {
		const haystack = entry.text.toLowerCase();
		let score = 0;
		let firstMatch = -1;

		const literalAt = literal === "" ? -1 : haystack.indexOf(literal);
		if (literalAt >= 0) {
			score += 10;
			firstMatch = literalAt;
		}
		for (const token of tokens) {
			const at = haystack.indexOf(token);
			if (at < 0) continue;
			score += 2;
			if (firstMatch < 0 || at < firstMatch) firstMatch = at;
		}
		if (entry.ref.toLowerCase() === literal) score += 20;
		if (score === 0) return;
		// Later entries win ties: recency matters more than position in a long log.
		score += index / Math.max(entries.length, 1);
		scored.push({ entry, score, firstMatch: Math.max(firstMatch, 0) });
	});

	return scored.sort((a, b) => b.score - a.score);
}

function listEntries(entries: readonly ContextEntry[], offset: number, limit: number): string {
	const page = entries.slice(offset, offset + limit);
	const lines = page.map((entry) => `- [${entry.ref}] ${entry.role} (${entry.text.length} chars)`);
	const shown = offset + page.length;
	const more = shown < entries.length ? `\nnext: task_context offset=${shown}` : "";
	return `${entries.length} context entries (showing ${offset + 1}-${shown}):\n${lines.join("\n")}${more}`;
}

/**
 * Read the snapshot.
 * - `refs`: original text of those entries, paginated by characters (`offset`/`limit`).
 * - `query`: keyword search over entry text, paginated by entries, each hit snippet carries its ref.
 * - neither: the brief plus an index of refs.
 */
export function queryContext(snapshot: TaskContextSnapshot, input: QueryContextInput = {}): string {
	const entries = safeEntries(snapshot);
	if (entries.length === 0) return "No prior context was captured for this task.";

	const refs = Array.isArray(input.refs) ? input.refs.filter((ref) => typeof ref === "string" && ref !== "") : [];

	if (refs.length > 0) {
		const offset = toInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
		const limit = toInt(input.limit, REF_PAGE_CHARS, 1, MAX_REF_PAGE_CHARS);
		const perEntry = refs.length === 1 ? limit : Math.max(200, Math.floor(limit / refs.length));
		const blocks = refs.map((ref) => {
			const entry = entries.find((candidate) => candidate.ref === ref);
			if (!entry) return `[${ref}] not found in this task's context snapshot.`;
			return renderRef(entry, offset, perEntry);
		});
		const hint = refs.length > 1 ? "\n\n(Request one ref at a time to page through its full text.)" : "";
		return `${blocks.join("\n\n")}${hint}`;
	}

	const query = typeof input.query === "string" ? input.query.trim() : "";
	if (query === "") {
		const offset = toInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
		const limit = toInt(input.limit, MAX_LISTING, 1, MAX_LISTING);
		const brief = typeof snapshot.brief === "string" && snapshot.brief !== "" ? `${snapshot.brief}\n\n` : "";
		return `${brief}${listEntries(entries, offset, limit)}`;
	}

	const matches = scoreEntries(entries, query);
	if (matches.length === 0) {
		return `No context entry matches "${query}". Call task_context without a query to list all ${entries.length} entries.`;
	}

	const offset = toInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
	const limit = toInt(input.limit, SEARCH_PAGE_SIZE, 1, 25);
	const page = matches.slice(offset, offset + limit);
	if (page.length === 0) {
		return `No further matches for "${query}" (${matches.length} total). Use offset below ${matches.length}.`;
	}

	const blocks = page.map(({ entry, firstMatch }) => {
		const snippet = snippetAround(entry.text, firstMatch);
		const full = entry.text.length > snippet.length ? `\nfull text: task_context refs=["${entry.ref}"]` : "";
		return `[${entry.ref}] ${entry.role}\n${snippet}${full}`;
	});
	const shown = offset + page.length;
	const more = shown < matches.length ? `\n\nnext: task_context query="${query}" offset=${shown}` : "";
	return `${matches.length} matches for "${query}" (showing ${offset + 1}-${shown}):\n\n${blocks.join("\n\n")}${more}`;
}
