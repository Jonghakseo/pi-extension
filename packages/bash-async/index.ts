import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AsyncTaskProvider } from "./async-task-provider.js";
import { guardQueuedDeliveries } from "./delivery-guard.js";
import { JobManager } from "./job-manager.js";
import { NotificationBatcher } from "./notification-batcher.js";
import { PollGuard } from "./poll-guard.js";
import {
	renderCallText,
	renderJobList,
	renderResultText,
	renderStart,
	renderStatus,
	renderStatusLine,
	renderTerminalLine,
} from "./render.js";
import { createRunningJobsWidget, type RunningJobsWidget } from "./running-jobs-widget.js";
import { collectReminderJobs, handleRunningReminderContext, ReminderAnchors } from "./running-reminder.js";
import {
	type BashAsyncParams,
	formatSyncWindow,
	MAX_OUTPUT_LINES,
	TOOL_LABEL,
	TOOL_NAME,
	toolDescription,
	toolParameters,
	validateBashAsyncParams,
} from "./tool-schema.js";
import { type BashAsyncResultDetails, isTerminalJobStatus, type StatusResultDetails } from "./types.js";

function result(text: string, details: BashAsyncResultDetails): AgentToolResult<BashAsyncResultDetails> {
	return { content: [{ type: "text", text }], details };
}

function errorResult(message: string): AgentToolResult<BashAsyncResultDetails> {
	return result(`bash_async: ${message}`, { error: message });
}

function pollBlockedResult(action: string, retryInMs: number): AgentToolResult<BashAsyncResultDetails> {
	return errorResult(
		`${action} is rate limited because nothing changed since the last identical query. Do not poll. Continue with work that does not depend on this job, or end the turn; results arrive automatically. Retry after ${Math.ceil(retryInMs / 1_000)}s if the user asks.`,
	);
}

const RUNNING_JOBS_WIDGET_KEY = "bash-async-running-jobs";
export const DEFAULT_SYNC_WINDOW_MS = 10_000;
/** A mistyped value must not turn every start into a long blocking call. */
export const MAX_SYNC_WINDOW_MS = 60_000;

/** Read once at registration so the tool description and start behavior agree; 0 restores purely asynchronous starts. */
export function syncWindowMs(): number {
	const raw = process.env.PI_BASH_ASYNC_SYNC_WINDOW_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_SYNC_WINDOW_MS;
	const configured = Number(raw);
	if (!Number.isFinite(configured) || configured < 0) return DEFAULT_SYNC_WINDOW_MS;
	return Math.min(MAX_SYNC_WINDOW_MS, Math.floor(configured));
}

/** The inline result replaces the follow-up, so it must end with the final lines, not the first ones. */
function terminalOutputResult(
	manager: JobManager,
	status: StatusResultDetails,
): AgentToolResult<BashAsyncResultDetails> {
	const tail = manager.tail(status.jobId, { lines: MAX_OUTPUT_LINES });
	if (!tail) return errorResult(`job not found: ${status.jobId}`);
	const notes: string[] = [];
	if (tail.startOffset > 0) notes.push(`showing the last ${tail.lines.length} of ${tail.nextOffset} lines`);
	if (tail.finalLineShortened) notes.push("the last line was shortened");
	if (tail.job.log.truncated) notes.push("the log stopped at its size cap");
	// The log path follows on its own line, so repeating it here would only cost context.
	const note = notes.length > 0 ? `(${notes.join("; ")}; read the log below for the full output)` : undefined;
	return result(
		[renderTerminalLine(tail.job, status), note, tail.lines.join("\n") || "(no output)", `Log: ${tail.job.log.path}`]
			.filter(Boolean)
			.join("\n"),
		{
			jobId: tail.job.id,
			status: tail.job.status,
			exitCode: tail.job.exitCode,
			runtimeMs: status.runtimeMs,
			errorSummary: status.errorSummary,
			logPath: tail.job.log.path,
			startOffset: tail.startOffset,
			nextOffset: tail.nextOffset,
			retainedFromOffset: tail.retainedFromOffset,
			logTruncated: tail.job.log.truncated,
		},
	);
}

function forgetJobPolls(pollGuard: PollGuard, jobId: string): void {
	pollGuard.forget(`status:${jobId}`);
	pollGuard.forget(`output:${jobId}`);
}

export default function bashAsync(host: ExtensionAPI): void {
	// Completions are queued while the agent is busy; the guard restores any the queue drops on Escape.
	const pi = guardQueuedDeliveries(host);
	const windowMs = syncWindowMs();
	let manager: JobManager;
	const pollGuard = new PollGuard();
	let uiContext: ExtensionContext | undefined;
	let runningJobsWidget: RunningJobsWidget | undefined;
	let widgetInstalled = false;
	// Jobs carry no session, and a hosted runtime can switch sessions while an earlier session's jobs run on.
	const jobSessions = new Map<string, string>();
	const reminderAnchors = new ReminderAnchors();

	const clearRunningJobsWidget = () => {
		const context = uiContext;
		if (!widgetInstalled && !runningJobsWidget) return;
		widgetInstalled = false;
		runningJobsWidget?.dispose();
		runningJobsWidget = undefined;
		try {
			context?.ui.setWidget(RUNNING_JOBS_WIDGET_KEY, undefined);
		} catch {
			// Widget teardown is best-effort and must not disrupt session shutdown.
		}
	};

	const syncRunningJobsWidget = () => {
		const context = uiContext;
		if (context?.mode !== "tui") return;
		if (manager.runningJobs().length === 0) {
			clearRunningJobsWidget();
			return;
		}
		if (widgetInstalled) {
			runningJobsWidget?.refresh();
			return;
		}
		widgetInstalled = true;
		try {
			context.ui.setWidget(
				RUNNING_JOBS_WIDGET_KEY,
				(tui, theme) => {
					runningJobsWidget?.dispose();
					runningJobsWidget = createRunningJobsWidget(tui, theme, {
						getRunningJobs: () => manager.runningJobs(),
					});
					return runningJobsWidget;
				},
				{ placement: "belowEditor" },
			);
		} catch {
			widgetInstalled = false;
		}
	};

	const provider = new AsyncTaskProvider(pi.events, "bash-async", "0.2.1", {
		cancel: async (id) => {
			await manager.kill(id);
		},
		detail: (id) => manager.output(id, { lines: 100 })?.text,
		close: () => {
			notifications.suppress();
			if (provider.supported) manager.closeAdmission();
		},
		deliveryResumed: () => notifications.flush(),
		reopen: () => {
			notifications.resume();
			manager.reopenAdmission();
			notifications.flush();
		},
	});
	pi.on("session_start", (_event, context) => {
		reminderAnchors.clear();
		provider.bind(context.sessionManager.getSessionId());
	});
	const notifications = new NotificationBatcher({
		deliveryState: (id) => provider.deliveryState(id),
		send: (message, options) => {
			provider.deliver(message.details.jobIds, message, (annotated) => pi.sendMessage(annotated, options));
		},
	});
	manager = new JobManager({
		provider,
		notifications,
		onStateChange: () => syncRunningJobsWidget(),
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: toolDescription(windowMs),
		parameters: toolParameters,
		executionMode: "parallel",
		promptSnippet:
			windowMs > 0
				? "Run finite non-interactive commands with bash_async."
				: "Run long finite non-interactive jobs with bash_async.",
		promptGuidelines: [
			windowMs > 0
				? `Use bash_async start for finite non-interactive commands. If the command finishes within ${formatSyncWindow(windowMs)}, start returns its final status and output inline; otherwise it keeps running in the background.`
				: "Use bash_async start only for finite non-interactive commands whose result is not needed immediately.",
			"Do not call sleep or poll status, output, or list to wait. Continue only with independent work; otherwise end the turn. Results arrive automatically: success after your current run ends, failure or timeout at the next tool boundary. Jobs you kill are not reported.",
			"Repeated status, output, or list queries that return no new information are rate limited and fail with an error.",
			"bash_async does not support TUI, REPL, stdin, or interactive terminal programs.",
		],
		renderCall(args) {
			const input = args as BashAsyncParams;
			return renderCallText(
				typeof input.action === "string" ? input.action : "invalid",
				typeof input.title === "string" ? input.title : undefined,
			);
		},
		renderResult(result, { expanded }, theme) {
			const text = renderResultText(result, expanded);
			return new Text(text ? theme.fg("toolOutput", text) : "", 0, 0);
		},
		async execute(_toolCallId, args, signal, _onUpdate, context) {
			if (context.mode === "tui") uiContext = context;
			else {
				clearRunningJobsWidget();
				uiContext = undefined;
			}
			const sessionId = context.sessionManager.getSessionId();
			const outcome = await execute(
				manager,
				pollGuard,
				(jobId) => {
					notifications.acknowledge(jobId);
					provider.discardPending(jobId);
				},
				args as BashAsyncParams,
				context,
				windowMs,
				signal,
			);
			const params = args as BashAsyncParams;
			const details = outcome.details as { jobId?: unknown } | undefined;
			if (params.action === "start" && typeof details?.jobId === "string") jobSessions.set(details.jobId, sessionId);
			return outcome;
		},
	});

	// context runs before every LLM call, including turns started by a delivered completion or a steer that
	// before_agent_start never sees, and including every request inside a tool loop. Reminders are pinned to
	// the message they were first rendered after so mid-turn requests keep them without moving the cached
	// prefix. They ride on the request copy and are never stored.
	pi.on("context", (event, context) => {
		if (jobSessions.size === 0 && reminderAnchors.isEmpty()) return;
		const sessionId = context.sessionManager.getSessionId();
		const tracked = collectReminderJobs(manager.list(), notifications.pendingJobs());
		const trackedIds = new Set(tracked.map((job) => job.id));
		for (const id of jobSessions.keys()) if (!trackedIds.has(id)) jobSessions.delete(id);
		const pending = tracked.filter((job) => jobSessions.get(job.id) === sessionId);
		return handleRunningReminderContext(reminderAnchors, sessionId, event.messages, pending, Date.now());
	});

	pi.on("session_shutdown", async () => {
		pollGuard.clear();
		reminderAnchors.clear();
		clearRunningJobsWidget();
		uiContext = undefined;
		provider.shutdown();
		manager.beginShutdown();
		await manager.abortAndSettleAll();
		manager.closeAllLogs();
	});
}

async function execute(
	manager: JobManager,
	pollGuard: PollGuard,
	acknowledge: (jobId: string) => void,
	args: BashAsyncParams,
	context: ExtensionContext,
	windowMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<BashAsyncResultDetails>> {
	const validation = validateBashAsyncParams(args);
	if (!validation.ok) return errorResult(validation.error);
	const params = validation.value;
	if (params.action === "start") {
		const started = await manager.start({
			command: params.command,
			title: params.title,
			cwd: params.cwd,
			timeoutSeconds: params.timeoutSeconds,
			context,
			acceptanceSignal: signal,
		});
		if (!started.ok) return errorResult(started.error);
		const jobId = started.details.jobId;
		// start drains synchronously, so a job still queued here waits for a concurrency slot, not for
		// a moment. Blocking on it would spend the whole window and learn nothing.
		if (windowMs > 0 && started.details.status === "running") {
			const terminal = await manager.waitForTerminal(jobId, windowMs, signal);
			if (!terminal && signal?.aborted) {
				// The user interrupted the run; a detached job would wake the agent again with a follow-up.
				await manager.kill(jobId);
			}
			const status = manager.status(jobId);
			if (status && isTerminalJobStatus(status.status)) {
				// The inline result replaces the follow-up, exactly like a terminal output read.
				forgetJobPolls(pollGuard, jobId);
				acknowledge(jobId);
				return terminalOutputResult(manager, status);
			}
			if (!status) {
				// A parallel start evicted the finished job while we waited. Its completion is still pending,
				// so it must not be acknowledged here: the follow-up is now the only way to learn the result.
				forgetJobPolls(pollGuard, jobId);
				return result(
					`Job ${jobId} finished while start was waiting and is no longer retained, so its final status is not in this result. It still arrives automatically; the log holds the full output.\nLog: ${started.details.logPath}`,
					{ jobId, logPath: started.details.logPath },
				);
			}
			// A job that was already running can only be terminal or still running, so the start result stands.
			return result(renderStart(started.details, windowMs), started.details);
		}
		return result(renderStart(started.details), started.details);
	}
	if (params.action === "list") {
		const jobs = manager.list();
		if (jobs.some((job) => !isTerminalJobStatus(job.status))) {
			const decision = pollGuard.check("list", jobs.map((job) => `${job.id}:${job.status}`).join(","));
			if (!decision.allowed) return pollBlockedResult("list", decision.retryInMs);
		}
		return result(renderJobList(jobs), { jobs });
	}
	if (params.action === "status") {
		const details = manager.status(params.jobId);
		if (!details) return errorResult(`job not found: ${params.jobId}`);
		// status carries no output or error summary, so it never replaces the completion follow-up.
		if (isTerminalJobStatus(details.status)) forgetJobPolls(pollGuard, params.jobId);
		else {
			const decision = pollGuard.check(`status:${params.jobId}`, details.status);
			if (!decision.allowed) return pollBlockedResult("status", decision.retryInMs);
		}
		return result(renderStatus(details), details);
	}
	if (params.action === "output") {
		const output = manager.output(params.jobId, params);
		if (!output) return errorResult(`job not found: ${params.jobId}`);
		const terminal = isTerminalJobStatus(output.job.status);
		if (terminal) {
			forgetJobPolls(pollGuard, params.jobId);
			acknowledge(params.jobId);
		} else {
			// Offsets identify the returned line range, so a range already seen means the caller learns nothing new.
			const decision = pollGuard.check(`output:${params.jobId}`, `${output.startOffset}:${output.nextOffset}`);
			// An incremental read that returned lines already moved its cursor, so dropping it would lose that output.
			const consumed = params.incremental === true && output.nextOffset > output.startOffset;
			if (!decision.allowed && !consumed) return pollBlockedResult("output", decision.retryInMs);
		}
		// A terminal read within the batch delay replaces the completion message, so it must carry the final status.
		const text = [
			terminal ? renderStatusLine(output.job) : undefined,
			output.warning,
			output.text || "(no output)",
			`Log: ${output.job.log.path}`,
		]
			.filter(Boolean)
			.join("\n");
		return result(text, {
			jobId: output.job.id,
			logPath: output.job.log.path,
			startOffset: output.startOffset,
			nextOffset: output.nextOffset,
			retainedFromOffset: output.retainedFromOffset,
			logTruncated: output.job.log.truncated,
			warning: output.warning,
		});
	}
	forgetJobPolls(pollGuard, params.jobId);
	const killed = await manager.kill(params.jobId);
	if (!killed) return errorResult(`job not found: ${params.jobId}`);
	// Only a job this kill stopped is replaced by the kill result. A job that already finished on its own
	// keeps its completion, since the kill result carries no output or error summary.
	if (killed.status === "killed") acknowledge(killed.id);
	const details = manager.status(killed.id);
	return details ? result(renderStatus(details), details) : errorResult(`job not found: ${params.jobId}`);
}
