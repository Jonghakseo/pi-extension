import { formatElapsed, sanitizeTitle } from "./running-jobs-widget.js";
import type { BashAsyncJob } from "./types.js";
import { isTerminalJobStatus } from "./types.js";

export const RUNNING_REMINDER_CUSTOM_TYPE = "bash-async-running-reminder";
const MAX_REMINDER_TITLE_LENGTH = 60;

type ReminderJob = Pick<BashAsyncJob, "id" | "title" | "status" | "queuedAt" | "startedAt">;

function shortTitle(title: string): string {
	const clean = sanitizeTitle(title).replaceAll('"', "'") || "bash job";
	return clean.length > MAX_REMINDER_TITLE_LENGTH ? `${clean.slice(0, MAX_REMINDER_TITLE_LENGTH - 3)}...` : clean;
}

/**
 * A new turn is not evidence that a job finished: turns also start for user input and for completions of
 * other jobs. Naming what is still pending lets the model tell the difference without polling.
 */
export function formatRunningReminder(jobs: readonly ReminderJob[], now: number): string | undefined {
	const pending = jobs.filter((job) => !isTerminalJobStatus(job.status));
	if (pending.length === 0) return undefined;
	const items = pending.map((job) => {
		const state = job.status === "queued" ? " queued" : "";
		return `bash_async job ${job.id} "${shortTitle(job.title)}"${state} ${formatElapsed(now - (job.startedAt ?? job.queuedAt))}`;
	});
	return `Still running (results NOT delivered yet): ${items.join("; ")}. Do not report their outcome, output, counts, hashes, or artifacts until their completion notification arrives.`;
}

/** Appends to the request copy only; Pi does not persist what context handlers return. */
export function withRunningReminder<T>(messages: readonly T[], text: string, now: number): T[] {
	const reminder = {
		role: "custom",
		customType: RUNNING_REMINDER_CUSTOM_TYPE,
		content: text,
		display: false,
		timestamp: now,
	} as unknown as T;
	return [...messages, reminder];
}
