/**
 * Per-request reminder of subagent runs whose results have not reached the model yet.
 *
 * Imports nothing beyond the leaf time-utils module so index.ts can register the context handler
 * without loading the core.
 */

import type { SubagentStore } from "./store.js";
import type { CommandRunState } from "./types.js";
import { formatElapsedSince } from "./utils/time-utils.js";

export const RUNNING_REMINDER_CUSTOM_TYPE = "subagent-running-reminder";
const MAX_REMINDER_TASK_LENGTH = 60;
/** Enough to cover a long turn; the oldest anchors fall off a session that runs agents for hours. */
const MAX_ANCHORS = 50;
/** A hosted runtime can serve a few sessions from one extension instance. */
const MAX_ANCHOR_SCOPES = 4;

type ReminderStore = Pick<SubagentStore, "globalLiveRuns" | "batchGroups" | "pipelines">;

function normalizeSessionFile(value: string | undefined | null): string {
	return typeof value === "string" ? value.replace(/[\r\n\t]+/g, "").trim() : "";
}

function shortTask(run: CommandRunState): string {
	const raw = (run.displayTask || run.task || "").replace(/\s+/g, " ").trim().replaceAll('"', "'");
	return raw.length > MAX_REMINDER_TASK_LENGTH ? `${raw.slice(0, MAX_REMINDER_TASK_LENGTH - 3)}...` : raw;
}

/**
 * Runs started from this session whose completion still goes to the model. Ownership matches
 * tool-execute's origin check: an unknown session file on either side counts as the same session.
 *
 * A finished run stays listed only while someone still owes its delivery: its own held completion, or
 * the batch or pipeline summary it belongs to. Entries whose group was already evicted are orphans and
 * must not keep the model quiet forever.
 */
export function collectPendingRuns(store: ReminderStore, currentSessionFile: string | undefined): CommandRunState[] {
	const current = normalizeSessionFile(currentSessionFile);
	const runs: CommandRunState[] = [];
	for (const entry of store.globalLiveRuns.values()) {
		const run = entry.runState;
		if (run.removed || run.deliveryMode === "humanOnly") continue;
		if (run.status !== "running" && !deliveryStillOwed(store, entry.pendingCompletion !== undefined, run)) continue;
		const origin = normalizeSessionFile(entry.originSessionFile);
		if (current && origin && current !== origin) continue;
		runs.push(run);
	}
	return runs.sort((left, right) => left.startedAt - right.startedAt || left.id - right.id);
}

function deliveryStillOwed(store: ReminderStore, hasPendingCompletion: boolean, run: CommandRunState): boolean {
	if (hasPendingCompletion) return true;
	if (run.batchId && store.batchGroups.has(run.batchId)) return true;
	return Boolean(run.pipelineId && store.pipelines.has(run.pipelineId));
}

export function formatRunningReminder(runs: readonly CommandRunState[], now: number): string | undefined {
	if (runs.length === 0) return undefined;
	const items = runs.map((run) => {
		const task = shortTask(run);
		const head = `subagent run #${run.id} ${run.agent}${task ? ` "${task}"` : ""}`;
		if (run.status !== "running") return `${head} finished, result not delivered yet`;
		return `${head} ${formatElapsedSince(run.startedAt, now)}`;
	});
	return `Still running or awaiting delivery (results NOT delivered yet): ${items.join("; ")}. Do not state their final outcome, counts, hashes, or artifacts until their completion notification arrives or you read their final status yourself; partial output you read via the tool may be described as in-progress.`;
}

interface Anchor {
	/** Frozen when the anchor is created, so later requests repeat it byte for byte. */
	text: string;
	timestamp: number;
}

interface AnchorScope {
	anchors: Map<string, Anchor>;
	/** Ids the most recently created anchor already names, so a shrinking set does not add anchors. */
	covered: ReadonlySet<string>;
}

/**
 * Pi clones the messages for every request, so an anchor cannot hold a message reference. Role,
 * timestamp, and the id of a tool result or custom message identify the same message across requests.
 */
function anchorKey(message: unknown): string | undefined {
	const candidate = message as
		| { role?: unknown; timestamp?: unknown; toolCallId?: unknown; customType?: unknown }
		| undefined;
	if (!candidate || typeof candidate.role !== "string" || typeof candidate.timestamp !== "number") return undefined;
	const detail =
		typeof candidate.toolCallId === "string"
			? candidate.toolCallId
			: typeof candidate.customType === "string"
				? candidate.customType
				: "";
	return `${candidate.role}|${candidate.timestamp}|${detail}`;
}

/**
 * Keeps the reminder visible inside a tool loop without breaking the prompt cache.
 *
 * Appending a freshly rendered reminder to every request would change the tail each time and invalidate
 * the cached prefix. Instead each reminder is pinned to the message it was first rendered after and
 * replayed there verbatim, so a request built later in the same turn only grows at the end.
 */
export class ReminderAnchors {
	/** Keyed by session file: a hosted runtime can route another session's request through this instance. */
	private readonly scopes = new Map<string, AnchorScope>();

	clear(): void {
		this.scopes.clear();
	}

	isEmpty(): boolean {
		for (const scope of this.scopes.values()) if (scope.anchors.size > 0) return false;
		return true;
	}

	apply<T>(
		session: string,
		messages: readonly T[],
		pending: { ids: readonly string[]; render: () => string | undefined },
		now: number,
	): { messages: T[] } | undefined {
		const known = this.scopes.get(session);
		if (pending.ids.length === 0 && !known?.anchors.size) return undefined;
		const scope = known ?? this.openScope(session);
		recordAnchor(scope, messages, pending, now);
		if (scope.anchors.size === 0) return undefined;
		return insertAnchors(scope.anchors, messages);
	}

	private openScope(session: string): AnchorScope {
		const scope: AnchorScope = { anchors: new Map(), covered: new Set() };
		this.scopes.set(session, scope);
		while (this.scopes.size > MAX_ANCHOR_SCOPES) {
			const oldest = this.scopes.keys().next().value;
			if (oldest === undefined) break;
			this.scopes.delete(oldest);
		}
		return scope;
	}
}

function recordAnchor<T>(
	scope: AnchorScope,
	messages: readonly T[],
	pending: { ids: readonly string[]; render: () => string | undefined },
	now: number,
): void {
	if (pending.ids.length === 0) return;
	const last = messages.at(-1);
	const key = anchorKey(last);
	if (!key) return;
	const continuesTurn = (last as { role?: unknown } | undefined)?.role === "toolResult";
	// Mid-turn requests only earn an anchor once work the model has not been warned about shows up.
	if (continuesTurn && pending.ids.every((id) => scope.covered.has(id))) return;
	const text = pending.render();
	if (!text) return;
	scope.anchors.set(key, { text, timestamp: now });
	scope.covered = new Set(pending.ids);
	while (scope.anchors.size > MAX_ANCHORS) {
		const oldest = scope.anchors.keys().next().value;
		if (oldest === undefined) break;
		scope.anchors.delete(oldest);
	}
}

function insertAnchors<T>(anchors: ReadonlyMap<string, Anchor>, messages: readonly T[]): { messages: T[] } | undefined {
	const result: T[] = [];
	let inserted = false;
	for (const message of messages) {
		result.push(message);
		const key = anchorKey(message);
		const anchor = key ? anchors.get(key) : undefined;
		if (!anchor) continue;
		result.push({
			role: "custom",
			customType: RUNNING_REMINDER_CUSTOM_TYPE,
			content: anchor.text,
			display: false,
			timestamp: anchor.timestamp,
		} as unknown as T);
		inserted = true;
	}
	return inserted ? { messages: result } : undefined;
}

/**
 * context handler body. Pi fires context before every LLM call, and does not persist the returned
 * messages, so the reminder never enters the transcript.
 */
export function handleRunningReminderContext<T>(
	anchors: ReminderAnchors,
	messages: readonly T[],
	store: ReminderStore | null | undefined,
	currentSessionFile: string | undefined,
	now = Date.now(),
): { messages: T[] } | undefined {
	const runs = store ? collectPendingRuns(store, currentSessionFile) : [];
	return anchors.apply(
		normalizeSessionFile(currentSessionFile),
		messages,
		{ ids: runs.map((run) => String(run.id)), render: () => formatRunningReminder(runs, now) },
		now,
	);
}
