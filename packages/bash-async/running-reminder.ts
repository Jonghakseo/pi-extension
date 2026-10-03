import { formatElapsed, sanitizeTitle } from "./running-jobs-widget.js";
import type { BashAsyncJob } from "./types.js";
import { isTerminalJobStatus } from "./types.js";

export const RUNNING_REMINDER_CUSTOM_TYPE = "bash-async-running-reminder";
const MAX_REMINDER_TITLE_LENGTH = 60;
/** Enough to cover a long turn; the oldest anchors fall off a session that runs jobs for hours. */
const MAX_ANCHORS = 50;
/** A hosted runtime can serve a few sessions from one extension instance. */
const MAX_ANCHOR_SCOPES = 4;

type ReminderJob = Pick<BashAsyncJob, "id" | "title" | "status" | "queuedAt" | "startedAt">;

function shortTitle(title: string): string {
	const clean = sanitizeTitle(title).replaceAll('"', "'") || "bash job";
	return clean.length > MAX_REMINDER_TITLE_LENGTH ? `${clean.slice(0, MAX_REMINDER_TITLE_LENGTH - 3)}...` : clean;
}

/**
 * Jobs the model must not report on yet: still running, or finished with the completion still queued.
 * The batcher-pending ones close the gap between "process exited" and "the model was told".
 */
export function collectReminderJobs(
	listed: readonly ReminderJob[],
	awaitingDelivery: readonly ReminderJob[],
): ReminderJob[] {
	const jobs: ReminderJob[] = [];
	const seen = new Set<string>();
	for (const job of listed) {
		if (isTerminalJobStatus(job.status)) continue;
		jobs.push(job);
		seen.add(job.id);
	}
	// The batcher keeps the record of a terminal job the manager may already have evicted.
	for (const job of awaitingDelivery) {
		if (seen.has(job.id)) continue;
		jobs.push(job);
		seen.add(job.id);
	}
	return jobs;
}

/**
 * A new turn is not evidence that a job finished: turns also start for user input and for completions of
 * other jobs. Naming what is still pending lets the model tell the difference without polling.
 */
export function formatRunningReminder(jobs: readonly ReminderJob[], now: number): string | undefined {
	if (jobs.length === 0) return undefined;
	const items = jobs.map((job) => {
		const head = `bash_async job ${job.id} "${shortTitle(job.title)}"`;
		if (isTerminalJobStatus(job.status)) return `${head} finished, result not delivered yet`;
		const state = job.status === "queued" ? " queued" : "";
		return `${head}${state} ${formatElapsed(now - (job.startedAt ?? job.queuedAt))}`;
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
	/** Keyed by session: a hosted runtime can route another session's request through the same instance. */
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
 * context handler body. Builds the request copy only; Pi does not persist what context handlers return.
 */
export function handleRunningReminderContext<T>(
	anchors: ReminderAnchors,
	session: string,
	messages: readonly T[],
	jobs: readonly ReminderJob[],
	now: number,
): { messages: T[] } | undefined {
	return anchors.apply(
		session,
		messages,
		{ ids: jobs.map((job) => job.id), render: () => formatRunningReminder(jobs, now) },
		now,
	);
}
