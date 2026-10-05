import { type Component, Text } from "@earendil-works/pi-tui";
import { formatSyncWindow } from "./tool-schema.js";
import type { BashAsyncJob, StartResultDetails, StatusResultDetails } from "./types.js";

export function renderStart(details: StartResultDetails, syncWindowMs = 0): string {
	const still = syncWindowMs > 0 ? ` and is still ${details.status} after ${formatSyncWindow(syncWindowMs)}` : "";
	return `Started background job ${details.jobId} (${details.status})${still}: ${details.title}\nDo not call sleep or poll status, output, or list to wait. Continue only with work that does not depend on this job; otherwise end the turn. Results arrive automatically once your current response and its tool calls finish, whether the job succeeded, failed, or timed out. Jobs you kill are not reported.`;
}

export function renderStatusLine(job: BashAsyncJob): string {
	const exit = job.exitCode === undefined || job.exitCode === null ? "" : ` (exit ${job.exitCode})`;
	return `[${job.id}] ${job.status}${exit}`;
}

/** Runtimes inside the sync window are often sub-second, where rounding to seconds would only print "0s". */
function formatRuntime(runtimeMs: number): string {
	const runtime = Math.max(0, runtimeMs);
	return runtime < 1_000 ? `${Math.round(runtime)}ms` : `${(runtime / 1_000).toFixed(1)}s`;
}

/** An inline start result replaces the follow-up, so it carries the runtime and error the follow-up would have shown. */
export function renderTerminalLine(job: BashAsyncJob, details: StatusResultDetails): string {
	const error = details.errorSummary ? `: ${details.errorSummary}` : "";
	return `${renderStatusLine(job)} in ${formatRuntime(details.runtimeMs)}${error}`;
}

export function renderStatus(details: StatusResultDetails): string {
	const exit = details.exitCode === undefined || details.exitCode === null ? "" : `, exit ${details.exitCode}`;
	return `${details.jobId}: ${details.status}${exit}, ${details.runtimeMs}ms\nLog: ${details.logPath}`;
}

export function renderJobList(jobs: BashAsyncJob[]): string {
	if (jobs.length === 0) return "No bash_async jobs.";
	return jobs.map((job) => `${job.id} ${job.status} ${job.title}`).join("\n");
}

export function renderCallText(action: string, title?: string): Component {
	return new Text(title ? `bash_async ${action}: ${title}` : `bash_async ${action}`, 0, 0);
}

export interface ToolResultLike {
	content: Array<{ type?: string; text?: string }>;
	details?: unknown;
}

/** Collapsed rows hide job payloads and agent-facing guidance; only errors stay visible. */
export function renderResultText(result: ToolResultLike, expanded: boolean): string {
	const text = result.content.find((part) => part.type === "text")?.text ?? "";
	if (expanded) return text;
	const details = result.details;
	const isError = typeof details === "object" && details !== null && "error" in details;
	return isError ? (text.split("\n")[0] ?? "") : "";
}
