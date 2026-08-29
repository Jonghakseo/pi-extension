import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JobManager } from "./job-manager.js";
import { NotificationBatcher } from "./notification-batcher.js";
import { renderCallText, renderJobList, renderStart, renderStatus } from "./render.js";
import { createRunningJobsWidget, type RunningJobsWidget } from "./running-jobs-widget.js";
import {
	type BashAsyncParams,
	TOOL_DESCRIPTION,
	TOOL_LABEL,
	TOOL_NAME,
	toolParameters,
	validateBashAsyncParams,
} from "./tool-schema.js";
import type { BashAsyncResultDetails } from "./types.js";

function result(text: string, details: BashAsyncResultDetails): AgentToolResult<BashAsyncResultDetails> {
	return { content: [{ type: "text", text }], details };
}

function errorResult(message: string): AgentToolResult<BashAsyncResultDetails> {
	return result(`bash_async: ${message}`, { error: message });
}

const RUNNING_JOBS_WIDGET_KEY = "bash-async-running-jobs";

export default function bashAsync(pi: ExtensionAPI): void {
	let manager: JobManager;
	let uiContext: ExtensionContext | undefined;
	let runningJobsWidget: RunningJobsWidget | undefined;
	let widgetInstalled = false;

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

	const notifications = new NotificationBatcher({
		send: (message, options) => {
			try {
				void Promise.resolve(pi.sendMessage(message, options)).catch(() => {});
			} catch {
				// Completion delivery is best-effort and must not disrupt finalization.
			}
		},
	});
	manager = new JobManager({
		notifications,
		onStateChange: () => syncRunningJobsWidget(),
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: TOOL_DESCRIPTION,
		parameters: toolParameters,
		executionMode: "parallel",
		promptSnippet: "Run long finite non-interactive jobs with bash_async.",
		promptGuidelines: [
			"Use bash_async start only for finite non-interactive commands whose result is not needed immediately.",
			"Do not call sleep or poll status, output, or list to wait. Continue only with independent work; otherwise end the turn. Every terminal result arrives automatically as a follow-up.",
			"bash_async does not support TUI, REPL, stdin, or interactive terminal programs.",
		],
		renderCall(args) {
			const input = args as BashAsyncParams;
			return renderCallText(
				typeof input.action === "string" ? input.action : "invalid",
				typeof input.title === "string" ? input.title : undefined,
			);
		},
		async execute(_toolCallId, args, signal, _onUpdate, context) {
			if (context.mode === "tui") uiContext = context;
			else {
				clearRunningJobsWidget();
				uiContext = undefined;
			}
			return execute(manager, args as BashAsyncParams, context, signal);
		},
	});

	pi.on("session_shutdown", async () => {
		clearRunningJobsWidget();
		uiContext = undefined;
		manager.beginShutdown();
		await manager.abortAndSettleAll();
		manager.closeAllLogs();
	});
}

async function execute(
	manager: JobManager,
	args: BashAsyncParams,
	context: ExtensionContext,
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
		return started.ok ? result(renderStart(started.details), started.details) : errorResult(started.error);
	}
	if (params.action === "list") {
		const jobs = manager.list();
		return result(renderJobList(jobs), { jobs });
	}
	if (params.action === "status") {
		const details = manager.status(params.jobId);
		return details ? result(renderStatus(details), details) : errorResult(`job not found: ${params.jobId}`);
	}
	if (params.action === "output") {
		const output = manager.output(params.jobId, params);
		if (!output) return errorResult(`job not found: ${params.jobId}`);
		const text = [output.warning, output.text || "(no output)", `Log: ${output.job.log.path}`]
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
	const killed = await manager.kill(params.jobId);
	if (!killed) return errorResult(`job not found: ${params.jobId}`);
	const details = manager.status(killed.id);
	return details ? result(renderStatus(details), details) : errorResult(`job not found: ${params.jobId}`);
}
