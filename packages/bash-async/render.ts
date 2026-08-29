import { type Component, Text } from "@earendil-works/pi-tui";
import type { BashAsyncJob, StartResultDetails, StatusResultDetails } from "./types.js";

export function renderStart(details: StartResultDetails): string {
	return `Started background job ${details.jobId} (${details.status}): ${details.title}\nDo not call sleep or poll status, output, or list to wait. Continue only with work that does not depend on this job; otherwise end the turn. Success, failure, timeout, and kill results arrive automatically as a follow-up.`;
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
