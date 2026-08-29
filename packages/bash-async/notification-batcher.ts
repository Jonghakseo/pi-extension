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

export interface CompletionBatcherOptions {
	send: (message: CompletionNotification, options: { triggerTurn: true; deliverAs: "followUp" }) => void;
	delayMs?: number;
}

export interface CompletedJob extends BashAsyncJob {
	tail: string[];
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let result = "";
	let size = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character);
		if (size + characterBytes > maxBytes) break;
		result += character;
		size += characterBytes;
	}
	return result;
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
	private timer: ReturnType<typeof setTimeout> | undefined;
	private suppressed = false;

	constructor(private readonly options: CompletionBatcherOptions) {
		this.delayMs = options.delayMs ?? COMPLETION_DELAY_MS;
	}

	enqueue(job: CompletedJob): void {
		if (this.suppressed || this.pending.has(job.id)) return;
		this.pending.set(job.id, job);
		this.timer ??= setTimeout(() => this.flush(), this.delayMs);
		this.timer.unref?.();
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.suppressed || this.pending.size === 0) {
			this.pending.clear();
			return;
		}

		const included: CompletedJob[] = [];
		let content = "";
		for (const job of this.pending.values()) {
			const entry = formatCompletion(job);
			const separator = content ? "\n\n" : "";
			if (Buffer.byteLength(content + separator + entry) > MAX_COMPLETION_MESSAGE_BYTES) break;
			included.push(job);
			content += separator + entry;
		}
		for (const job of included) this.pending.delete(job.id);
		if (included.length > 0) {
			this.options.send(
				{
					customType: "bash-async-completion",
					content,
					display: true,
					details: { jobIds: included.map((job) => job.id) },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
		if (this.pending.size > 0 && !this.suppressed) {
			this.timer = setTimeout(() => this.flush(), this.delayMs);
			this.timer.unref?.();
		}
	}

	suppress(): void {
		this.suppressed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
	}
}
