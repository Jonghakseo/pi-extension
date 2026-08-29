export const BASH_ASYNC_ACTIONS = ["start", "status", "output", "kill", "list"] as const;
export type BashAsyncAction = (typeof BASH_ASYNC_ACTIONS)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "killed", "shutdown"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "timed_out", "killed", "shutdown"] as const;
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

export const JOB_TERMINAL_CAUSES = [
	"natural",
	"nonzero",
	"timeout",
	"kill",
	"shutdown",
	"spawn_error",
	"cleanup_error",
] as const;
export type JobTerminalCause = (typeof JOB_TERMINAL_CAUSES)[number];

export interface BashAsyncStartParams {
	action: "start";
	command: string;
	title?: string;
	cwd?: string;
	timeoutSeconds: number;
}

export interface BashAsyncJobParams {
	action: "status" | "output" | "kill";
	jobId: string;
	lines?: number;
	outputOffset?: number;
	incremental?: boolean;
}

export interface BashAsyncListParams {
	action: "list";
}

export type NormalizedBashAsyncParams = BashAsyncStartParams | BashAsyncJobParams | BashAsyncListParams;

export interface JobLogSummary {
	path: string;
	bytes: number;
	truncated: boolean;
}

export interface BashAsyncJob {
	id: string;
	status: JobStatus;
	title: string;
	command: string;
	cwd: string;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	timeoutSeconds: number;
	log: JobLogSummary;
	exitCode?: number | null;
	errorSummary?: string;
	terminalCause?: JobTerminalCause;
}

export interface StartResultDetails {
	jobId: string;
	status: "queued" | "running";
	title: string;
	command: string;
	cwd: string;
	queuedAt: number;
	timeoutSeconds: number;
	logPath: string;
}

export interface StatusResultDetails {
	jobId: string;
	status: JobStatus;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	runtimeMs: number;
	exitCode?: number | null;
	errorSummary?: string;
	logPath: string;
	logBytes: number;
	logTruncated: boolean;
}

export interface OutputResultDetails {
	jobId: string;
	logPath: string;
	startOffset: number;
	nextOffset: number;
	retainedFromOffset: number;
	logTruncated: boolean;
	warning?: string;
}

export type BashAsyncResultDetails =
	| StartResultDetails
	| StatusResultDetails
	| OutputResultDetails
	| Record<string, unknown>;

export function isTerminalJobStatus(status: JobStatus): status is TerminalJobStatus {
	return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

export function canTransitionJobStatus(from: JobStatus, to: JobStatus): boolean {
	if (from === "queued") return to === "running" || to === "killed" || to === "shutdown";
	if (from === "running") return isTerminalJobStatus(to);
	return false;
}

/**
 * Returns a copied job with its status changed only when `expected` and the state
 * machine transition both match. The input job is never mutated.
 */
export function compareAndSetJobStatus<T extends { status: JobStatus }>(
	job: T,
	expected: JobStatus | readonly JobStatus[],
	next: JobStatus,
): T | undefined {
	const expectedStatuses = typeof expected === "string" ? [expected] : expected;
	if (!expectedStatuses.includes(job.status) || !canTransitionJobStatus(job.status, next)) return undefined;
	return { ...job, status: next };
}

export function terminalStatusForCause(cause: JobTerminalCause): TerminalJobStatus {
	switch (cause) {
		case "natural":
			return "succeeded";
		case "nonzero":
		case "spawn_error":
		case "cleanup_error":
			return "failed";
		case "timeout":
			return "timed_out";
		case "kill":
			return "killed";
		case "shutdown":
			return "shutdown";
	}
}
