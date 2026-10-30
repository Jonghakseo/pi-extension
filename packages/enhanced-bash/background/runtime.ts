import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withFailureHints } from "../platform.js";
import { AsyncTaskProvider } from "./async-task-provider.js";
import { guardQueuedDeliveries } from "./delivery-guard.js";
import { type ExecutionAdapter, JobManager } from "./job-manager.js";
import { NotificationBatcher } from "./notification-batcher.js";
import { renderAdopted, renderResultText, renderStart, renderStatus, renderTerminalLine } from "./render.js";
import { createRunningJobsWidget, type RunningJobsWidget } from "./running-jobs-widget.js";
import { collectReminderJobs, handleRunningReminderContext, ReminderAnchors } from "./running-reminder.js";
import { DEFAULT_TIMEOUT_SECONDS, MAX_OUTPUT_LINES } from "./tool-schema.js";
import { type BashAsyncResultDetails, isTerminalJobStatus, type StatusResultDetails } from "./types.js";

export const STOP_TOOL_NAME = "bash_stop";
const RUNNING_JOBS_WIDGET_KEY = "enhanced-bash-running-jobs";
export const DEFAULT_SYNC_WINDOW_MS = 10_000;
/** A mistyped value must not turn every background start into a long blocking call. */
export const MAX_SYNC_WINDOW_MS = 60_000;

/** Read once at registration so the tool description and start behavior agree; 0 makes background starts return at once. */
export function syncWindowMs(): number {
	const raw = process.env.PI_ENHANCED_BASH_SYNC_WINDOW_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_SYNC_WINDOW_MS;
	const configured = Number(raw);
	if (!Number.isFinite(configured) || configured < 0) return DEFAULT_SYNC_WINDOW_MS;
	return Math.min(MAX_SYNC_WINDOW_MS, Math.floor(configured));
}

export interface BackgroundStartParams {
	command: string;
	title?: string;
	cwd?: string;
	/** Seconds the job may run. Defaults to 3600; 0 disables the limit. */
	timeout?: number;
}

export interface AdoptParams {
	command: string;
	title: string;
	waitedSeconds: number;
	recentLines: string[];
	timeoutSeconds: number;
	execute: ExecutionAdapter;
	/** Abort signal of the call being adopted; aborting it stops the new job. */
	signal?: AbortSignal;
}

export interface BackgroundRuntime {
	readonly syncWindowMs: number;
	/** Starts a background job and waits up to the sync window for it to finish inline. */
	start(
		params: BackgroundStartParams,
		context: ExtensionContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<BashAsyncResultDetails>>;
	/** Hands an already running foreground command to the background. Throws when the job cannot be accepted. */
	adopt(params: AdoptParams, context: ExtensionContext): Promise<AgentToolResult<BashAsyncResultDetails>>;
}

function result(text: string, details: BashAsyncResultDetails): AgentToolResult<BashAsyncResultDetails> {
	return { content: [{ type: "text", text }], details };
}

function errorResult(message: string): AgentToolResult<BashAsyncResultDetails> {
	return result(`bash: ${message}`, { error: message });
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
	const output = tail.lines.join("\n");
	return result(
		[
			renderTerminalLine(tail.job, status),
			note,
			(status.status === "failed" ? withFailureHints(output) : output) || "(no output)",
			`Log: ${tail.job.log.path}`,
		]
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

export function registerBackgroundRuntime(host: ExtensionAPI): BackgroundRuntime {
	// Completions are queued while the agent is busy; the guard restores any the queue drops on Escape.
	const pi = guardQueuedDeliveries(host);
	const windowMs = syncWindowMs();
	let manager: JobManager;
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

	const provider = new AsyncTaskProvider(pi.events, "enhanced-bash", "0.1.0", {
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

	/** A result that settles the job replaces its follow-up, so the queued completion must be dropped. */
	const acknowledge = (jobId: string) => {
		notifications.acknowledge(jobId);
		provider.discardPending(jobId);
	};

	const trackContext = (context: ExtensionContext) => {
		if (context.mode === "tui") uiContext = context;
		else {
			clearRunningJobsWidget();
			uiContext = undefined;
		}
	};

	pi.registerTool({
		name: STOP_TOOL_NAME,
		label: "Bash Stop",
		description:
			"Stop a background bash job by its job ID. A job you stop is not reported again. Background jobs come from bash with runInBackground, or from a foreground command that outlived its timeout.",
		parameters: Type.Object({
			jobId: Type.String({ description: "Job ID returned when the command moved to the background." }),
		}),
		executionMode: "parallel",
		promptSnippet: "Stop a background bash job with bash_stop.",
		renderCall(args, theme) {
			const jobId = (args as { jobId?: unknown }).jobId;
			const label = theme.fg("toolTitle", theme.bold(STOP_TOOL_NAME));
			return new Text(typeof jobId === "string" ? `${label} ${theme.fg("accent", jobId)}` : label, 0, 0);
		},
		renderResult(toolResult, { expanded }, theme) {
			const text = renderResultText(toolResult, expanded);
			return new Text(text ? theme.fg("toolOutput", text) : "", 0, 0);
		},
		async execute(_toolCallId, args) {
			const jobId = (args as { jobId?: unknown }).jobId;
			if (typeof jobId !== "string" || jobId.trim() === "") return errorResult("bash_stop requires a non-empty jobId.");
			const killed = await manager.kill(jobId);
			if (!killed) return errorResult(`job not found: ${jobId}`);
			// Only a job this call stopped loses its follow-up. A job that already finished on its own keeps its
			// completion, since this result carries no output or error summary.
			if (killed.status === "killed") acknowledge(killed.id);
			const details = manager.status(killed.id);
			return details ? result(renderStatus(details), details) : errorResult(`job not found: ${jobId}`);
		},
	});

	const start: BackgroundRuntime["start"] = async (params, context, signal) => {
		trackContext(context);
		const sessionId = context.sessionManager.getSessionId();
		const started = await manager.start({
			command: params.command,
			title: params.title,
			cwd: params.cwd,
			timeoutSeconds: params.timeout ?? DEFAULT_TIMEOUT_SECONDS,
			context,
			acceptanceSignal: signal,
		});
		if (!started.ok) return errorResult(started.error);
		const jobId = started.details.jobId;
		jobSessions.set(jobId, sessionId);
		// start drains synchronously, so a job still queued here waits for a concurrency slot, not for a moment.
		// Blocking on it would spend the whole window and learn nothing.
		if (windowMs <= 0 || started.details.status !== "running")
			return result(renderStart(started.details), started.details);
		const terminal = await manager.waitForTerminal(jobId, windowMs, signal);
		if (!terminal && signal?.aborted) {
			// The user interrupted the run; a detached job would wake the agent again with a follow-up.
			await manager.kill(jobId);
		}
		const status = manager.status(jobId);
		if (status && isTerminalJobStatus(status.status)) {
			acknowledge(jobId);
			return terminalOutputResult(manager, status);
		}
		if (!status) {
			// A parallel start evicted the finished job while we waited. Its completion is still pending, so it
			// must not be acknowledged here: the follow-up is now the only way to learn the result.
			return result(
				`Job ${jobId} finished while bash was waiting and is no longer retained, so its final status is not in this result. It still arrives automatically; the log holds the full output.\nLog: ${started.details.logPath}`,
				{ jobId, logPath: started.details.logPath },
			);
		}
		return result(renderStart(started.details, windowMs), started.details);
	};

	const adopt: BackgroundRuntime["adopt"] = async (params, context) => {
		trackContext(context);
		const sessionId = context.sessionManager.getSessionId();
		const started = await manager.start({
			command: params.command,
			title: params.title,
			timeoutSeconds: params.timeoutSeconds,
			context,
			execute: params.execute,
			immediate: true,
			acceptanceSignal: params.signal,
		});
		if (!started.ok)
			throw new Error(
				`Command outlived its ${params.waitedSeconds}s timeout and was stopped because it could not move to the background: ${started.error}`,
			);
		const jobId = started.details.jobId;
		if (params.signal?.aborted) {
			// The user interrupted while the job was being accepted; a detached job would wake the agent again.
			await manager.kill(jobId);
			acknowledge(jobId);
			throw new Error("Command aborted");
		}
		jobSessions.set(jobId, sessionId);
		return result(renderAdopted(started.details, params.waitedSeconds, params.recentLines), started.details);
	};

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
		reminderAnchors.clear();
		clearRunningJobsWidget();
		uiContext = undefined;
		provider.shutdown();
		manager.beginShutdown();
		await manager.abortAndSettleAll();
		manager.closeAllLogs();
	});

	return { syncWindowMs: windowMs, start, adopt };
}
