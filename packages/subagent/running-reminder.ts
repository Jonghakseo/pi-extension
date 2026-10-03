/**
 * Per-request reminder of subagent runs whose results have not reached the model yet.
 *
 * Kept free of runtime imports so index.ts can register the context handler without loading the core.
 */

import type { SubagentStore } from "./store.js";
import type { CommandRunState } from "./types.js";

export const RUNNING_REMINDER_CUSTOM_TYPE = "subagent-running-reminder";
const MAX_REMINDER_TASK_LENGTH = 60;

type ReminderStore = Pick<SubagentStore, "globalLiveRuns">;

function normalizeSessionFile(value: string | undefined | null): string {
	return typeof value === "string" ? value.replace(/[\r\n\t]+/g, "").trim() : "";
}

function shortTask(run: CommandRunState): string {
	const raw = (run.displayTask || run.task || "").replace(/\s+/g, " ").trim().replaceAll('"', "'");
	return raw.length > MAX_REMINDER_TASK_LENGTH ? `${raw.slice(0, MAX_REMINDER_TASK_LENGTH - 3)}...` : raw;
}

function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 > 0 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/**
 * Runs started from this session whose completion still goes to the model. Ownership matches
 * tool-execute's origin check: an unknown session file on either side counts as the same session.
 */
export function collectPendingRuns(store: ReminderStore, currentSessionFile: string | undefined): CommandRunState[] {
	const current = normalizeSessionFile(currentSessionFile);
	const runs: CommandRunState[] = [];
	for (const entry of store.globalLiveRuns.values()) {
		const run = entry.runState;
		if (run.status !== "running" || run.removed || run.deliveryMode === "humanOnly") continue;
		const origin = normalizeSessionFile(entry.originSessionFile);
		if (current && origin && current !== origin) continue;
		runs.push(run);
	}
	return runs.sort((left, right) => left.startedAt - right.startedAt || left.id - right.id);
}

export function formatRunningReminder(runs: readonly CommandRunState[], now: number): string | undefined {
	if (runs.length === 0) return undefined;
	const items = runs.map((run) => {
		const task = shortTask(run);
		return `subagent run #${run.id} ${run.agent}${task ? ` "${task}"` : ""} ${formatElapsed(now - run.startedAt)}`;
	});
	return `Still running (results NOT delivered yet): ${items.join("; ")}. Do not report their outcome, output, counts, hashes, or artifacts until their completion notification arrives.`;
}

/**
 * context handler body. Pi fires context before every LLM call, including turns started by a delivered
 * completion, and does not persist the returned messages, so the reminder never enters the transcript.
 */
export function handleRunningReminderContext<T>(
	messages: readonly T[],
	store: ReminderStore | null | undefined,
	currentSessionFile: string | undefined,
	now = Date.now(),
): { messages: T[] } | undefined {
	if (!store || store.globalLiveRuns.size === 0) return undefined;
	const text = formatRunningReminder(collectPendingRuns(store, currentSessionFile), now);
	if (!text) return undefined;
	const reminder = {
		role: "custom",
		customType: RUNNING_REMINDER_CUSTOM_TYPE,
		content: text,
		display: false,
		timestamp: now,
	} as unknown as T;
	return { messages: [...messages, reminder] };
}
