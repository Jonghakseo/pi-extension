import { truncateUtf8 } from "./job-log.js";
import type { BashAsyncJob } from "./types.js";

export const COMPLETION_DELAY_MS = 500;
export const MAX_COMPLETION_MESSAGE_BYTES = 8 * 1024;
export const MAX_COMPLETION_TAIL_BYTES = 2 * 1024;
export const MAX_COMPLETION_TAIL_LINES = 20;

export interface CompletionNotification {
	customType: "bash-async-completion";
	content: string;
	display: boolean;
	details: { jobIds: string[] };
}

export type CompletionDelivery = "steer" | "followUp";

export interface CompletionBatcherOptions {
	send: (message: CompletionNotification, options: { triggerTurn: true; deliverAs: CompletionDelivery }) => void;
	delayMs?: number;
	deliveryState?: (jobId: string) => "send" | "hold" | "discard";
}

/** A failure can invalidate the work the agent is doing now, so it interrupts at the next tool boundary. */
const INTERRUPTING_STATUSES: ReadonlySet<BashAsyncJob["status"]> = new Set(["failed", "timed_out"]);

export interface CompletedJob extends BashAsyncJob {
	tail: string[];
}

function formatDuration(job: BashAsyncJob): string {
	const end = job.endedAt ?? Date.now();
	const start = job.startedAt ?? job.queuedAt;
	return `${Math.max(0, Math.round((end - start) / 1000))}s`;
}

function formatCompletion(job: CompletedJob): string {
	const status =
		job.exitCode === undefined || job.exitCode === null ? job.status : `${job.status} (exit ${job.exitCode})`;
	const tail = truncateUtf8(job.tail.slice(-MAX_COMPLETION_TAIL_LINES).join("\n"), MAX_COMPLETION_TAIL_BYTES);
	const output = tail ? `\n${tail}` : "\n(no output)";
	return truncateUtf8(
		`[bash_async ${job.id}] ${job.title}: ${status} in ${formatDuration(job)}${output}\nLog: ${job.log.path}`,
		MAX_COMPLETION_MESSAGE_BYTES,
	);
}

export class NotificationBatcher {
	private readonly delayMs: number;
	private readonly pending = new Map<string, CompletedJob>();
	/** Each job gets its own grace period, so a kill or output read right after it finishes still counts. */
	private readonly readyAt = new Map<string, number>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private suppressed = false;

	constructor(private readonly options: CompletionBatcherOptions) {
		this.delayMs = options.delayMs ?? COMPLETION_DELAY_MS;
	}

	enqueue(job: CompletedJob): void {
		if (this.suppressed || this.pending.has(job.id)) return;
		this.pending.set(job.id, job);
		this.readyAt.set(job.id, Date.now() + this.delayMs);
		this.schedule(this.delayMs);
	}

	/**
	 * Drops a completion the agent already learned about through a terminal output read, an inline start
	 * result, or kill. Only effective inside the job's grace period: Pi cannot recall a message once it is sent.
	 */
	acknowledge(jobId: string): void {
		this.remove(jobId);
	}

	/** Jobs that already finished but whose completion has not reached the model yet. */
	pendingJobs(): readonly CompletedJob[] {
		return [...this.pending.values()];
	}

	/** Sends every job past its grace period. Held jobs wait for the next flush from a delivery hook. */
	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.suppressed) return;

		const now = Date.now();
		const included: CompletedJob[] = [];
		let content = "";
		let full = false;
		let nextReady = Number.POSITIVE_INFINITY;
		for (const job of [...this.pending.values()]) {
			const readyAt = this.readyAt.get(job.id) ?? now;
			if (readyAt > now) {
				nextReady = Math.min(nextReady, readyAt);
				continue;
			}
			const state = this.options.deliveryState?.(job.id) ?? "send";
			if (state === "discard") this.remove(job.id);
			if (state !== "send" || full) continue;
			const entry = formatCompletion(job);
			const separator = content ? "\n\n" : "";
			if (Buffer.byteLength(content + separator + entry) > MAX_COMPLETION_MESSAGE_BYTES) {
				// The rest goes in the next message, after this one is queued.
				full = true;
				nextReady = Math.min(nextReady, now + this.delayMs);
				continue;
			}
			included.push(job);
			content += separator + entry;
		}
		for (const job of included) this.remove(job.id);
		if (included.length > 0) {
			const interrupting = included.some((job) => INTERRUPTING_STATUSES.has(job.status));
			this.options.send(
				{
					customType: "bash-async-completion",
					content,
					display: true,
					details: { jobIds: included.map((job) => job.id) },
				},
				{ triggerTurn: true, deliverAs: interrupting ? "steer" : "followUp" },
			);
		}
		if (Number.isFinite(nextReady)) this.schedule(Math.max(0, nextReady - now));
	}

	resume(): void {
		this.suppressed = false;
	}

	suppress(): void {
		this.suppressed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
		this.readyAt.clear();
	}

	private remove(jobId: string): void {
		this.pending.delete(jobId);
		this.readyAt.delete(jobId);
	}

	private schedule(delayMs: number): void {
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), delayMs);
		this.timer.unref?.();
	}
}
