/** biome-ignore-all lint/suspicious/noExplicitAny: subagent tool execution bridges untyped session state, UI hooks, and tool payloads. */
/**
 * Subagent tool execute handler — extracted from commands.ts for modularity.
 *
 * createSubagentToolExecute(pi, store) returns the async execute function
 * that is passed to pi.registerTool({ execute: ... }).
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.js";
import { parseSubagentToolCommand, SUBAGENT_CLI_HELP_TEXT } from "./cli.js";
import {
	DEFAULT_TURN_COUNT,
	IDLE_RUN_WARNING_THRESHOLD,
	MAX_BATCH_RUNS,
	MAX_CHAIN_STEPS,
	MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS,
	MAX_LISTED_RUNS,
	STATUS_OUTPUT_PREVIEW_MAX_CHARS,
	SUBAGENT_POLL_COOLDOWN_MS,
	SUBAGENT_STRONG_WAIT_MESSAGE,
} from "./constants.js";
import { isContextOverflowText } from "./context-limits.js";
import {
	buildSubagentDisplayTaskFallback,
	createDisplayTaskRefreshToken,
	isDisplayTaskRefreshTokenCurrent,
	shouldSummarizeSubagentTask,
	summarizeSubagentDisplayTask,
} from "./display-task.js";
import { ESCALATION_EXIT_CODE, readAndConsumeEscalation } from "./escalation.js";
import {
	formatContextUsageBar,
	formatUsageStats,
	getUsedContextPercent,
	resolveContextWindow,
	truncateLines,
} from "./format.js";
import { clearPendingGroupCompletion, upsertPendingGroupCompletion } from "./group-pending.js";
import { enqueueSubagentInvocation } from "./invocation-queue.js";
import { appendDisplayTaskUpdate, getSessionFileSize } from "./persisted-session.js";
import { clearFinishedRuns, formatCommandRunSummary, removeRun, trimCommandRunHistory } from "./run-utils.js";
import { getFinalOutput, getLastNonEmptyLine, runSingleAgent } from "./runner.js";
import {
	buildMainContextText,
	buildPipelineReferenceSection,
	makeSubagentSessionFile,
	stripTaskEchoFromMainContext,
	wrapTaskWithMainContext,
	wrapTaskWithPipelineContext,
} from "./session.js";
import { type SubagentStore, updateRunFromResult } from "./store.js";
import type {
	BatchOrChainItem,
	CommandRunState,
	OnUpdateCallback,
	PendingCompletion,
	PipelineStepResult,
	SingleResult,
	SubagentDetails,
	SubagentLaunchSummary,
} from "./types.js";
import type { ShortLabelContext } from "./utils/short-label.js";
import { updateCommandRunsWidget, type WidgetRenderCtx } from "./widget.js";

type SessionToolCall = {
	name: string;
	argsText: string;
};

type SessionTurnToolCalls = {
	turn: number;
	toolCalls: SessionToolCall[];
};

type SessionDetailSummary = {
	finalOutput: string;
	turns: SessionTurnToolCalls[];
	error?: string;
};

type ResultFailureDiagnosis = {
	failed: boolean;
	reason?: string;
	/** Set when the failure was caused by exceeding the model context window. */
	contextOverflow?: boolean;
};

type AssistantTextPart = { type: "text"; text: string };
type AssistantToolCallPart = { type: "toolCall"; name?: string; arguments?: unknown };
type AssistantContentPart = AssistantTextPart | AssistantToolCallPart;
type AssistantMessageEntry = { type?: string; message?: { role?: string; content?: unknown } };

type LaunchMode = "single" | "batch" | "chain";

type RunLaunchConfig = {
	agent: string;
	taskForDisplay: string;
	taskForAgent: string;
	inheritMainContext: boolean;
	originSessionFile: string;
	continuedFromRunId?: number;
	batchId?: string;
	pipelineId?: string;
	pipelineStepIndex?: number;
	existingRunState?: CommandRunState;
};

type FinalizedRun = {
	runState: CommandRunState;
	result?: SingleResult;
	isError: boolean;
	rawOutput: string;
};

type SubagentExecuteResult = {
	content: { type: "text"; text: string }[];
	details: SubagentDetails;
	isError?: boolean;
};

type SubagentToolExecuteContext = {
	cwd: string;
	hasUI?: boolean;
	model?: ShortLabelContext["model"];
	modelRegistry?: {
		getAll: () => Array<{ provider: string; id: string; contextWindow?: number }>;
		getApiKeyAndHeaders?: (model: NonNullable<ShortLabelContext["model"]>) => Promise<{
			ok: boolean;
			apiKey?: string;
			headers?: Record<string, string>;
		}>;
	};
	sessionManager: {
		getSessionFile?: () => string | undefined;
		getEntries: () => unknown[];
	};
	registerDispose?: (cb: () => void) => void;
	ui?: {
		setWidget: (...args: any[]) => void;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
};

function refreshDisplayTaskInBackground(
	runState: CommandRunState,
	rawTask: string,
	ctx: SubagentToolExecuteContext,
	store: SubagentStore,
): void {
	if (!shouldSummarizeSubagentTask(rawTask, runState.displayTask ?? "")) return;
	if (!ctx.model || !ctx.modelRegistry?.getApiKeyAndHeaders) return;

	const refreshToken = createDisplayTaskRefreshToken(runState);
	void summarizeSubagentDisplayTask(rawTask, {
		model: ctx.model,
		modelRegistry: {
			getApiKeyAndHeaders: ctx.modelRegistry.getApiKeyAndHeaders,
		},
	})
		.then((displayTask) => {
			if (!displayTask || runState.removed) return;
			if (!isDisplayTaskRefreshTokenCurrent(runState, refreshToken)) return;
			if (displayTask === runState.displayTask) return;
			runState.displayTask = displayTask;
			const originSessionFile = store.globalLiveRuns.get(runState.id)?.originSessionFile;
			appendDisplayTaskUpdate(originSessionFile, {
				runId: runState.id,
				task: runState.task,
				displayTask,
				startedAt: runState.startedAt,
			});
			updateCommandRunsWidget(store);
		})
		.catch(() => {
			// Ignore background summary failures.
		});
}

function stringifyToolCallArguments(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
}

function getAssistantTextPart(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	for (const part of content as AssistantContentPart[]) {
		if (part?.type === "text" && typeof part.text === "string") {
			return part.text;
		}
	}
	return "";
}

function parseSessionDetailSummary(sessionFile?: string): SessionDetailSummary {
	if (!sessionFile) {
		return { finalOutput: "", turns: [], error: "Session file is not available for this run." };
	}
	if (!fs.existsSync(sessionFile)) {
		return {
			finalOutput: "",
			turns: [],
			error:
				`Session file not found: ${sessionFile}. ` +
				"The subagent likely exited before producing any persisted message (turn=0 / no output).",
		};
	}

	let raw = "";
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown read error";
		return { finalOutput: "", turns: [], error: `Failed to read session file: ${message}` };
	}

	const assistantMessages: Array<{ content?: unknown }> = [];
	const turns: SessionTurnToolCalls[] = [];

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;

		let entry: AssistantMessageEntry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry?.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;

		assistantMessages.push(entry.message);
		const turn = assistantMessages.length;
		const toolCalls: SessionToolCall[] = [];
		const content = entry.message.content;

		if (Array.isArray(content)) {
			for (const part of content as AssistantContentPart[]) {
				if (part?.type !== "toolCall") continue;
				const name = typeof part.name === "string" ? part.name : "tool";
				const argsText = stringifyToolCallArguments(part.arguments);
				toolCalls.push({ name, argsText });
			}
		}

		if (toolCalls.length > 0) {
			turns.push({ turn, toolCalls });
		}
	}

	let finalOutput = "";
	for (let i = assistantMessages.length - 1; i >= 0; i--) {
		const text = getAssistantTextPart(assistantMessages[i]?.content);
		if (text) {
			finalOutput = text;
			break;
		}
	}

	return { finalOutput, turns };
}

export function diagnoseResultFailure(result: SingleResult): ResultFailureDiagnosis {
	if (result.exitCode !== 0 || result.stopReason === "error") {
		const overflowText = result.errorMessage || result.stderr || getFinalOutput(result.messages);
		if (isContextOverflowText(overflowText)) {
			const turns = result.usage?.turns ?? 0;
			return {
				failed: true,
				contextOverflow: true,
				reason:
					`Subagent stopped after exceeding the model context window (${turns} turn(s) completed). ` +
					"Partial findings recovered below. To finish, narrow the task scope, split it, or use a larger-context model.",
			};
		}
	}
	if (result.exitCode !== 0) return { failed: true, reason: `Subagent process exited with code ${result.exitCode}.` };
	if (result.stopReason === "error")
		return { failed: true, reason: result.errorMessage || "Subagent reported stopReason=error." };
	if (result.stopReason === "aborted") return { failed: true, reason: "Subagent execution was aborted." };

	const finalOutput = getFinalOutput(result.messages).trim();
	const hasAssistantText = finalOutput.length > 0;
	if (hasAssistantText) return { failed: false };

	const stderr = (result.stderr || "").trim();
	if (result.messages.length === 0) {
		return {
			failed: true,
			reason:
				"Subagent returned no messages (turn=0). " +
				(stderr ? `stderr: ${stderr}` : "No stderr captured. Child process may have exited before producing output."),
		};
	}

	return {
		failed: true,
		reason: `Subagent finished without assistant text output. ${stderr ? `stderr: ${stderr}` : "No stderr captured."}`,
	};
}

function formatRunDetailOutput(run: CommandRunState): string {
	const sessionSummary = parseSessionDetailSummary(run.sessionFile);
	const runOutput = run.lastOutput?.trim() ? run.lastOutput : "";
	const sessionOutput = sessionSummary.finalOutput?.trim() ? sessionSummary.finalOutput : "";
	const lineOutput = run.lastLine?.trim() ? run.lastLine : "";
	const output = runOutput || sessionOutput || lineOutput || "(no output)";
	const lines: string[] = [formatCommandRunSummary(run), `Prompt: ${run.task}`];

	if (run.runtime) lines.push(`Runtime: ${run.runtime}`);
	if (run.runtime === "claude" && run.claudeSessionId) lines.push(`Claude Session: ${run.claudeSessionId}`);
	if (run.sessionFile) lines.push(`Session: ${run.sessionFile}`);
	if (run.thoughtText) lines.push(`Thought: ${run.thoughtText}`);

	lines.push("", "Result:", output, "", "Tool calls by turn:");

	if (sessionSummary.error) {
		lines.push(`- (session parse error) ${sessionSummary.error}`);
	}

	if (sessionSummary.turns.length === 0) {
		lines.push("- (no tool calls)");
	} else {
		for (const turn of sessionSummary.turns) {
			lines.push(`Turn ${turn.turn}:`);
			for (const toolCall of turn.toolCalls) {
				lines.push(`  - ${toolCall.name}${toolCall.argsText ? ` ${toolCall.argsText}` : ""}`);
			}
		}
	}

	return lines.join("\n");
}

function getRunCounts(store: SubagentStore): { running: number; idle: number } {
	const dedupedRunning = new Map<number, CommandRunState>();

	for (const [runId, run] of store.commandRuns) {
		if (run.removed) continue;
		dedupedRunning.set(runId, run);
	}

	for (const [runId, entry] of store.globalLiveRuns) {
		if (entry.runState.removed) continue;
		dedupedRunning.set(runId, entry.runState);
	}

	const running = Array.from(dedupedRunning.values()).filter((run) => run.status === "running").length;
	const idle = Array.from(store.commandRuns.values()).filter((run) => !run.removed && run.status !== "running").length;
	return { running, idle };
}

function formatIdleRunWarning(idleRunCount: number): string {
	return (
		`⚠️ Idle subagent runs: ${idleRunCount}. ` +
		`There are at least ${IDLE_RUN_WARNING_THRESHOLD} completed or failed runs that have not been removed. ` +
		"Remove unneeded runs with `subagent remove <runId|all>`."
	);
}

function getCurrentSessionFile(ctx: SubagentToolExecuteContext): string {
	try {
		const raw = ctx.sessionManager.getSessionFile?.() ?? "";
		return typeof raw === "string" ? raw.replace(/[\r\n\t]+/g, "").trim() : "";
	} catch {
		return "";
	}
}

function isInOriginSession(ctx: SubagentToolExecuteContext, originSessionFile: string): boolean {
	const currentSessionFile = getCurrentSessionFile(ctx);
	return !currentSessionFile || !originSessionFile || currentSessionFile === originSessionFile;
}

function createEmptyDetails(
	mode: LaunchMode,
	inheritMainContext: boolean,
	projectAgentsDir: string | null,
	launches: SubagentLaunchSummary[] = [],
): SubagentDetails {
	return {
		mode,
		inheritMainContext,
		projectAgentsDir,
		results: [],
		launches,
	};
}

function buildRunStartMessage(runState: CommandRunState, status: "started" | "resumed") {
	const contextLabel = runState.contextMode === "main" ? "main context" : "dedicated sub-session";
	return {
		customType: "subagent-tool" as const,
		content:
			`[subagent:${runState.agent}#${runState.id}] ${status}` +
			`\nContext: ${contextLabel} · turn ${runState.turnCount}`,
		display: false,
		details: {
			runId: runState.id,
			agent: runState.agent,
			task: runState.task,
			displayTask: runState.displayTask,
			continuedFromRunId: runState.continuedFromRunId,
			turnCount: runState.turnCount,
			contextMode: runState.contextMode,
			sessionFile: runState.sessionFile,
			persistedSessionBaseOffset: runState.persistedSessionBaseOffset,
			status,
			startedAt: runState.startedAt,
			elapsedMs: runState.elapsedMs,
			lastActivityAt: runState.lastActivityAt,
			thoughtText: runState.thoughtText,
			batchId: runState.batchId,
			pipelineId: runState.pipelineId,
			pipelineStepIndex: runState.pipelineStepIndex,
			runtime: runState.runtime,
			claudeSessionId: runState.claudeSessionId,
			claudeProjectDir: runState.claudeProjectDir,
		},
	};
}

function buildRunCompletionMessage(finalized: FinalizedRun, options?: { display?: boolean }) {
	const { runState, result, isError, rawOutput } = finalized;
	const usage = result ? formatUsageStats(result.usage, result.model) : "";
	return {
		customType: "subagent-tool" as const,
		content:
			`[subagent:${runState.agent}#${runState.id}] ${isError ? "failed" : "completed"}` +
			`\nPrompt: ${truncateLines(runState.task, 2)}` +
			(usage ? `\nUsage: ${usage}` : "") +
			(runState.thoughtText ? `\nThought: ${runState.thoughtText}` : "") +
			`\n\n${rawOutput}`,
		display: options?.display ?? true,
		details: {
			runId: runState.id,
			agent: runState.agent,
			task: runState.task,
			displayTask: runState.displayTask,
			continuedFromRunId: runState.continuedFromRunId,
			turnCount: runState.turnCount,
			contextMode: runState.contextMode,
			sessionFile: runState.sessionFile,
			persistedSessionBaseOffset: runState.persistedSessionBaseOffset,
			startedAt: runState.startedAt,
			elapsedMs: runState.elapsedMs,
			lastActivityAt: runState.lastActivityAt,
			exitCode: result?.exitCode,
			usage: result?.usage,
			model: result?.model,
			source: result?.agentSource,
			thoughtText: runState.thoughtText,
			status: runState.status,
			batchId: runState.batchId,
			pipelineId: runState.pipelineId,
			pipelineStepIndex: runState.pipelineStepIndex,
			runtime: runState.runtime,
			claudeSessionId: runState.claudeSessionId,
			claudeProjectDir: runState.claudeProjectDir,
		},
	};
}

function buildEscalationMessage(runState: CommandRunState, escalationMessage: string, result: SingleResult) {
	const usage = formatUsageStats(result.usage, result.model);
	return {
		customType: "subagent-tool" as const,
		content:
			`[subagent:${runState.agent}#${runState.id}] escalated` +
			`\nPrompt: ${truncateLines(runState.task, 2)}` +
			(usage ? `\nUsage: ${usage}` : "") +
			`\n\n[ESCALATION] ${escalationMessage}`,
		display: true,
		details: {
			runId: runState.id,
			agent: runState.agent,
			task: runState.task,
			displayTask: runState.displayTask,
			status: "error" as const,
			persistedSessionBaseOffset: runState.persistedSessionBaseOffset,
			startedAt: runState.startedAt,
			elapsedMs: runState.elapsedMs,
			lastActivityAt: runState.lastActivityAt,
			exitCode: result.exitCode,
			usage: result.usage,
			model: result.model,
			batchId: runState.batchId,
			pipelineId: runState.pipelineId,
			pipelineStepIndex: runState.pipelineStepIndex,
			runtime: runState.runtime,
			claudeSessionId: runState.claudeSessionId,
			claudeProjectDir: runState.claudeProjectDir,
		},
	};
}

function buildStrongWaitMessage(runId: number): string {
	return `Run #${runId} is still running.\n${SUBAGENT_STRONG_WAIT_MESSAGE}`;
}

function finalizeRunState(runState: CommandRunState, result: SingleResult): FinalizedRun {
	updateRunFromResult(runState, result);

	if (result.exitCode === ESCALATION_EXIT_CODE && runState.sessionFile) {
		const escalation = readAndConsumeEscalation(runState.sessionFile);
		const escalationMsg = escalation?.message ?? "Subagent escalated without a message.";
		runState.status = "error";
		runState.elapsedMs = Date.now() - runState.startedAt;
		runState.lastOutput = `[ESCALATION] ${escalationMsg}`;
		runState.lastLine = `[ESCALATION] ${escalationMsg}`;
		return {
			runState,
			result,
			isError: true,
			rawOutput: `[ESCALATION] ${escalationMsg}`,
		};
	}

	const failure = diagnoseResultFailure(result);
	const isError = failure.failed;
	runState.status = isError ? "error" : "done";
	runState.elapsedMs = Date.now() - runState.startedAt;
	let rawOutput: string;
	if (isError && failure.contextOverflow) {
		const partial = getFinalOutput(result.messages).trim();
		rawOutput = [
			failure.reason,
			partial ? `\n\n--- Partial findings (last output before cutoff) ---\n${partial}` : "",
			`\n\n(Run \`subagent detail ${runState.id}\` for the full tool-call trace.)`,
		].join("");
	} else if (isError) {
		rawOutput =
			failure.reason || result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	} else {
		rawOutput = getFinalOutput(result.messages) || "(no output)";
	}
	runState.lastOutput = rawOutput;
	runState.lastLine = getLastNonEmptyLine(rawOutput) || rawOutput;

	return { runState, result, isError, rawOutput };
}

function formatBatchSummary(batchId: string, runs: CommandRunState[], terminalStatus: "completed" | "error"): string {
	const headerStatus = runs.map((run) => `#${run.id} ${run.status === "done" ? "done" : "error"}`).join(", ");
	const body = runs
		.map((run) => {
			const summary = run.lastOutput?.trim() || run.lastLine?.trim() || "(no output)";
			return `#${run.id} ${run.agent}\n- ${summary}`;
		})
		.join("\n\n");
	return `[subagent-batch#${batchId}] ${terminalStatus}\nRuns: ${headerStatus}\n\n${body}`;
}

function formatPipelineSummary(
	pipelineId: string,
	stepResults: PipelineStepResult[],
	terminalStatus: "completed" | "stopped" | "error",
): string {
	const steps = stepResults
		.map(
			(step, index) =>
				`Step ${index + 1} · #${step.runId} ${step.agent} · ${step.status}\nTask: ${step.task}\n${step.output}`,
		)
		.join("\n\n");
	return `[subagent-chain#${pipelineId}] ${terminalStatus}\n\n${steps}`;
}

function toLaunchSummary(
	runState: Pick<CommandRunState, "agent" | "id" | "batchId" | "pipelineId" | "pipelineStepIndex">,
	mode: SubagentLaunchSummary["mode"],
): SubagentLaunchSummary {
	return {
		agent: runState.agent,
		mode,
		runId: runState.id,
		batchId: runState.batchId,
		pipelineId: runState.pipelineId,
		stepIndex: runState.pipelineStepIndex,
	};
}

function buildRunAnalyticsSummary(
	runState: Pick<
		CommandRunState,
		"id" | "agent" | "status" | "elapsedMs" | "model" | "batchId" | "pipelineId" | "pipelineStepIndex" | "runtime"
	>,
): Record<string, unknown> {
	return {
		runId: runState.id,
		agent: runState.agent,
		status: runState.status,
		elapsedMs: runState.elapsedMs,
		model: runState.model,
		batchId: runState.batchId,
		pipelineId: runState.pipelineId,
		stepIndex: runState.pipelineStepIndex,
		runtime: runState.runtime,
	};
}

function makePendingCompletion(message: PendingCompletion["message"], triggerTurn = true): PendingCompletion {
	return {
		message,
		options: { deliverAs: "followUp", triggerTurn },
		createdAt: Date.now(),
	};
}

function isInteractiveTuiContext(ctx: SubagentToolExecuteContext): boolean {
	return Boolean(ctx.hasUI && process.stdin.isTTY && process.stdout.isTTY);
}

function finalizeRunError(runState: CommandRunState, error: unknown): FinalizedRun {
	runState.status = "error";
	runState.elapsedMs = Date.now() - runState.startedAt;
	runState.lastLine = error instanceof Error ? error.message : "Subagent execution failed";
	runState.lastOutput = runState.lastLine;
	return {
		runState,
		isError: true,
		rawOutput: runState.lastLine,
	};
}

export function createSubagentToolExecute(pi: ExtensionAPI, store: SubagentStore) {
	const execute = async (
		_toolCallId: string,
		params: Record<string, any>,
		signal: AbortSignal | undefined,
		_onUpdate: OnUpdateCallback | undefined,
		ctx: SubagentToolExecuteContext,
	): Promise<SubagentExecuteResult> => {
		const knownRunIds = Array.from(store.commandRuns.values())
			.filter((run) => !run.removed)
			.map((run) => run.id);
		const parsedCommand = parseSubagentToolCommand(params.command, { knownRunIds });

		const hasRunningRuns = Array.from(store.commandRuns.values()).some((r) => !r.removed && r.status === "running");
		const isLaunchAction =
			parsedCommand.type === "params" &&
			(parsedCommand.params.asyncAction === "run" ||
				parsedCommand.params.asyncAction === "batch" ||
				parsedCommand.params.asyncAction === "chain" ||
				parsedCommand.params.asyncAction === "list");
		const shouldAutoClearFinishedRuns = isLaunchAction || !hasRunningRuns;

		if (shouldAutoClearFinishedRuns) {
			const clearedRunIds = clearFinishedRuns(store, {
				ctx,
				pi,
				updateWidget: true,
				removalReason: "tool-auto-clear",
			});
			for (const runId of clearedRunIds) {
				store.recentLaunchTimestamps.delete(runId);
			}
		}

		if (parsedCommand.type === "error") {
			return {
				content: [{ type: "text", text: `${parsedCommand.message}\n\n${SUBAGENT_CLI_HELP_TEXT}` }],
				details: createEmptyDetails("single", false, null),
				isError: true,
			};
		}

		if (parsedCommand.type === "help") {
			return {
				content: [{ type: "text", text: SUBAGENT_CLI_HELP_TEXT }],
				details: createEmptyDetails("single", false, null),
			};
		}

		const discovery = discoverAgents(ctx.cwd);
		const agents = discovery.agents;

		if (parsedCommand.type === "agents") {
			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "No subagents found." }],
					details: createEmptyDetails("single", false, discovery.projectAgentsDir),
				};
			}

			const lines = agents.map((agent) => {
				const model = agent.model ?? "(inherit current model)";
				const thinking = agent.thinking ?? "(inherit current thinking)";
				const tools = agent.tools && agent.tools.length > 0 ? agent.tools.join(",") : "default";
				const description = agent.description ? ` · ${agent.description}` : "";
				return `${agent.name} [${agent.source}] · model: ${model} · thinking: ${thinking} · tools: ${tools}${description}`;
			});

			return {
				content: [{ type: "text", text: `Available subagents\n\n${lines.join("\n")}` }],
				details: createEmptyDetails("single", false, discovery.projectAgentsDir),
			};
		}

		const cmdParams = parsedCommand.params;
		const asyncAction = cmdParams.asyncAction ?? "run";
		const contextMode = cmdParams.contextMode ?? "isolated";
		const inheritMainContext = contextMode === "main";
		const rawMainContext = inheritMainContext ? buildMainContextText(ctx) : { text: "", totalMessageCount: 0 };
		const mainContextText = rawMainContext.text;
		const totalMessageCount = rawMainContext.totalMessageCount;
		const mainSessionFile = inheritMainContext ? getCurrentSessionFile(ctx) || undefined : undefined;
		const originSessionFile = getCurrentSessionFile(ctx);

		const runCounts = getRunCounts(store);
		const idleRunWarning =
			runCounts.idle >= IDLE_RUN_WARNING_THRESHOLD ? formatIdleRunWarning(runCounts.idle) : undefined;
		const withIdleRunWarning = (text: string): string => (idleRunWarning ? `${idleRunWarning}\n\n${text}` : text);

		if (idleRunWarning && ctx.hasUI) {
			ctx.ui?.notify?.(idleRunWarning, "warning");
		}

		const hasBatch = asyncAction === "batch";
		const hasChain = asyncAction === "chain";
		const hasSingle = asyncAction === "run" || asyncAction === "continue";
		const mode: LaunchMode = hasBatch ? "batch" : hasChain ? "chain" : "single";
		const shouldRunAsync = isInteractiveTuiContext(ctx);
		const makeDetails = (
			modeOverride: LaunchMode = mode,
			results: SingleResult[] = [],
			launches: SubagentLaunchSummary[] = [],
		): SubagentDetails => ({
			mode: modeOverride,
			inheritMainContext,
			projectAgentsDir: discovery.projectAgentsDir,
			results,
			launches,
		});

		if ((hasSingle || hasBatch || hasChain) && inheritMainContext && !mainSessionFile) {
			return {
				content: [
					{
						type: "text",
						text: "contextMode=main requires an active main session. Current session is unavailable (e.g. --no-session).",
					},
				],
				details: makeDetails(),
				isError: true,
			};
		}

		// Early validation: check that all requested agent names exist before launching
		if (hasSingle || hasBatch || hasChain) {
			const requestedNames: string[] = [];
			if (hasSingle) {
				const name = (cmdParams.agent as string | undefined) ?? (cmdParams.continueFromRunId ? undefined : "worker");
				if (name) requestedNames.push(name);
			}
			if (hasBatch && Array.isArray(cmdParams.runs)) {
				for (const item of cmdParams.runs as BatchOrChainItem[]) requestedNames.push(item.agent);
			}
			if (hasChain && Array.isArray(cmdParams.steps)) {
				for (const step of cmdParams.steps as BatchOrChainItem[]) requestedNames.push(step.agent);
			}
			const unknownNames = [...new Set(requestedNames)].filter((name) => !agents.some((a) => a.name === name));
			if (unknownNames.length > 0) {
				const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `❌ Unknown agent${unknownNames.length > 1 ? "s" : ""}: ${unknownNames.map((n) => `"${n}"`).join(", ")}.\n\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails(),
					isError: true,
				};
			}
		}

		if (asyncAction === "list") {
			// Anti-polling guard: block list while any run is within launch cooldown
			const now = Date.now();
			const cooldownRunId = Array.from(store.commandRuns.values()).find((run) => {
				if (run.status !== "running") return false;
				const launchedAt = store.recentLaunchTimestamps.get(run.id);
				return typeof launchedAt === "number" && now - launchedAt <= SUBAGENT_POLL_COOLDOWN_MS;
			})?.id;
			if (cooldownRunId !== undefined) {
				return {
					content: [{ type: "text", text: buildStrongWaitMessage(cooldownRunId) }],
					details: makeDetails("single"),
					isError: true,
				};
			}

			const allRuns = Array.from(store.commandRuns.values()).sort((a, b) => b.id - a.id);
			if (allRuns.length === 0) {
				return {
					content: [{ type: "text", text: withIdleRunWarning("No subagent runs found.") }],
					details: makeDetails("single"),
				};
			}
			const visibleRuns = allRuns.slice(0, MAX_LISTED_RUNS);
			const hiddenCount = allRuns.length - visibleRuns.length;
			const lines = visibleRuns.map((run) => {
				const contextWindow = resolveContextWindow(ctx, run.model);
				const usedPercent = getUsedContextPercent(run.usage?.contextTokens, contextWindow);
				const usageSuffix = usedPercent === undefined ? "" : ` usage:${formatContextUsageBar(usedPercent)}`;
				const taskPreview = truncateLines(run.task, 2).replace(/\n/g, "\n  ");
				return `${formatCommandRunSummary(run)}${usageSuffix}\n  ${taskPreview}`;
			});
			const header =
				hiddenCount > 0
					? `Subagent runs (showing ${visibleRuns.length} of ${allRuns.length}, oldest ${hiddenCount} hidden)`
					: "Subagent runs";
			return {
				content: [{ type: "text", text: withIdleRunWarning(`${header}\n\n${lines.join("\n\n")}`) }],
				details: makeDetails("single"),
			};
		}

		const rawRunIds = Array.isArray(cmdParams.runIds) ? cmdParams.runIds : undefined;
		const invalidRunIds = (rawRunIds ?? []).filter((value) => !Number.isInteger(value));
		if (invalidRunIds.length > 0) {
			return {
				content: [{ type: "text", text: "runIds must be an array of integer run IDs." }],
				details: makeDetails("single"),
				isError: true,
			};
		}

		const runIdsFromArray = ((rawRunIds ?? []) as number[]).filter((value) => Number.isInteger(value));
		const hasRunId = Number.isInteger(cmdParams.runId);
		const hasRunIds = runIdsFromArray.length > 0;
		const isBulkAction = asyncAction === "abort" || asyncAction === "remove";

		if (!hasSingle && !hasBatch && !hasChain) {
			if (!isBulkAction && rawRunIds !== undefined) {
				return {
					content: [{ type: "text", text: `asyncAction=${asyncAction} does not support runIds. Use runId.` }],
					details: makeDetails("single"),
					isError: true,
				};
			}

			if (hasRunId && hasRunIds) {
				return {
					content: [{ type: "text", text: "Use either runId or runIds, not both." }],
					details: makeDetails("single"),
					isError: true,
				};
			}

			if (!hasRunId && !hasRunIds) {
				const required = isBulkAction ? "runId or runIds" : "runId";
				return {
					content: [{ type: "text", text: `asyncAction=${asyncAction} requires ${required}.` }],
					details: makeDetails("single"),
					isError: true,
				};
			}

			const targetRunIds = hasRunIds ? Array.from(new Set(runIdsFromArray)) : [cmdParams.runId as number];
			const firstRunId = targetRunIds[0];

			if (asyncAction === "status" || asyncAction === "detail") {
				const run = store.commandRuns.get(firstRunId);
				if (!run) {
					return {
						content: [{ type: "text", text: `Unknown subagent run #${firstRunId}.` }],
						details: makeDetails("single"),
						isError: true,
					};
				}

				const launchedAt = store.recentLaunchTimestamps.get(run.id);
				const withinCooldown =
					run.status === "running" &&
					typeof launchedAt === "number" &&
					Date.now() - launchedAt <= SUBAGENT_POLL_COOLDOWN_MS;
				if (withinCooldown) {
					return {
						content: [{ type: "text", text: buildStrongWaitMessage(run.id) }],
						details: makeDetails("single"),
						isError: true,
					};
				}

				if (asyncAction === "status") {
					const output = run.lastOutput ?? run.lastLine ?? "(no output yet)";
					const preview =
						output.length > STATUS_OUTPUT_PREVIEW_MAX_CHARS
							? `${output.slice(0, STATUS_OUTPUT_PREVIEW_MAX_CHARS)}\n\n... [truncated]`
							: output;
					return {
						content: [{ type: "text", text: `${formatCommandRunSummary(run)}\n${run.task}\n\n${preview}` }],
						details: makeDetails("single"),
					};
				}

				if (run.status === "running") {
					return {
						content: [
							{ type: "text", text: `Subagent run #${run.id} is still running. detail is available after completion.` },
						],
						details: makeDetails("single"),
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: formatRunDetailOutput(run) }],
					details: makeDetails("single"),
				};
			}

			if (asyncAction === "abort") {
				const aborting: number[] = [];
				const notRunning: number[] = [];
				const unknown: number[] = [];

				for (const runId of targetRunIds) {
					const run = store.commandRuns.get(runId);
					if (!run) {
						unknown.push(runId);
						continue;
					}

					const abortCtrl = run.abortController ?? store.globalLiveRuns.get(run.id)?.abortController;
					if (run.status !== "running" || !abortCtrl) {
						notRunning.push(runId);
						continue;
					}

					run.lastLine = "Aborting by subagent tool...";
					run.lastOutput = run.lastLine;
					abortCtrl.abort();
					aborting.push(runId);
				}

				if (aborting.length > 0) {
					updateCommandRunsWidget(store, ctx as WidgetRenderCtx);
				}

				if (targetRunIds.length === 1 && aborting.length === 1 && notRunning.length === 0 && unknown.length === 0) {
					return {
						content: [{ type: "text", text: `Aborting subagent run #${aborting[0]}...` }],
						details: makeDetails("single"),
					};
				}

				const lines: string[] = [];
				if (aborting.length > 0) lines.push(`Aborting: ${aborting.map((id) => `#${id}`).join(", ")}.`);
				if (notRunning.length > 0) lines.push(`Not running: ${notRunning.map((id) => `#${id}`).join(", ")}.`);
				if (unknown.length > 0) lines.push(`Unknown: ${unknown.map((id) => `#${id}`).join(", ")}.`);
				if (lines.length === 0) lines.push("No subagent runs matched.");

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: makeDetails("single"),
				};
			}

			if (asyncAction === "remove") {
				const removed: number[] = [];
				const abortedWhileRemoving: number[] = [];
				const unknown: number[] = [];

				for (const runId of targetRunIds) {
					const run = store.commandRuns.get(runId);
					if (!run) {
						unknown.push(runId);
						continue;
					}

					const { removed: didRemove, aborted } = removeRun(store, run.id, {
						ctx,
						pi,
						reason: "Aborting by subagent tool remove...",
						removalReason: "tool-remove",
						updateWidget: false,
					});
					if (!didRemove) {
						unknown.push(runId);
						continue;
					}

					removed.push(runId);
					store.recentLaunchTimestamps.delete(runId);
					if (aborted) abortedWhileRemoving.push(runId);
				}

				if (removed.length > 0) {
					updateCommandRunsWidget(store, ctx as WidgetRenderCtx);
				}

				if (targetRunIds.length === 1 && removed.length === 1 && unknown.length === 0) {
					return {
						content: [
							{
								type: "text",
								text:
									abortedWhileRemoving.length > 0
										? `Removed subagent run #${removed[0]} (aborting in background).`
										: `Removed subagent run #${removed[0]}.`,
							},
						],
						details: makeDetails("single"),
					};
				}

				const lines: string[] = [];
				if (removed.length > 0) lines.push(`Removed: ${removed.map((id) => `#${id}`).join(", ")}.`);
				if (abortedWhileRemoving.length > 0)
					lines.push(`Aborting in background: ${abortedWhileRemoving.map((id) => `#${id}`).join(", ")}.`);
				if (unknown.length > 0) lines.push(`Unknown: ${unknown.map((id) => `#${id}`).join(", ")}.`);
				if (lines.length === 0) lines.push("No subagent runs matched.");

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: makeDetails("single"),
				};
			}
		}

		const requestedLaunchCount = hasBatch
			? Array.isArray(cmdParams.runs)
				? cmdParams.runs.length
				: 0
			: hasChain
				? 1
				: 1;
		if (runCounts.running + requestedLaunchCount > MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS) {
			return {
				content: [
					{
						type: "text",
						text: withIdleRunWarning(
							`Too many running subagent runs (${runCounts.running}). Max is ${MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS}. Wait for completion, abort unnecessary runs, or remove stale runs before starting more runs.`,
						),
					},
				],
				details: makeDetails(),
				isError: true,
			};
		}

		const parentAbortCleanups = new Map<number, () => void>();

		function clearParentAbortListener(runId: number): void {
			const cleanup = parentAbortCleanups.get(runId);
			if (!cleanup) return;
			cleanup();
			parentAbortCleanups.delete(runId);
		}

		function linkParentAbortSignal(runId: number, abortController: AbortController): void {
			clearParentAbortListener(runId);
			if (!signal || shouldRunAsync) return;

			const abortFromParent = () => abortController.abort();
			if (signal.aborted) {
				abortFromParent();
				return;
			}

			signal.addEventListener("abort", abortFromParent, { once: true });
			parentAbortCleanups.set(runId, () => signal.removeEventListener("abort", abortFromParent));
		}

		function clearRunAbortState(runState: CommandRunState): void {
			clearParentAbortListener(runState.id);
			runState.abortController = undefined;
		}

		function registerRunLaunch(config: RunLaunchConfig): CommandRunState {
			const initialDisplayTask = buildSubagentDisplayTaskFallback(config.taskForDisplay);
			let runState: CommandRunState;
			if (config.existingRunState) {
				runState = config.existingRunState;
				runState.agent = config.agent;
				runState.task = config.taskForDisplay;
				runState.displayTask = initialDisplayTask;
				runState.status = "running";
				runState.startedAt = Date.now();
				runState.lastActivityAt = Date.now();
				runState.elapsedMs = 0;
				runState.toolCalls = 0;
				runState.lastLine = "";
				runState.lastOutput = "";
				runState.usage = undefined;
				runState.model = undefined;
				runState.removed = false;
				runState.turnCount = Math.max(DEFAULT_TURN_COUNT, runState.turnCount || DEFAULT_TURN_COUNT) + 1;
				runState.contextMode = runState.contextMode ?? (config.inheritMainContext ? "main" : "sub");
				runState.continuedFromRunId = config.continuedFromRunId;
				runState.sessionFile = runState.sessionFile ?? makeSubagentSessionFile(runState.id);
				runState.persistedSessionBaseOffset = getSessionFileSize(runState.sessionFile);
				runState.source = "tool";
			} else {
				const runId = store.nextCommandRunId++;
				runState = {
					id: runId,
					agent: config.agent,
					task: config.taskForDisplay,
					displayTask: initialDisplayTask,
					status: "running",
					startedAt: Date.now(),
					lastActivityAt: Date.now(),
					elapsedMs: 0,
					toolCalls: 0,
					lastLine: "",
					lastOutput: "",
					continuedFromRunId: config.continuedFromRunId,
					turnCount: DEFAULT_TURN_COUNT,
					sessionFile: makeSubagentSessionFile(runId),
					persistedSessionBaseOffset: getSessionFileSize(makeSubagentSessionFile(runId)),
					removed: false,
					contextMode: config.inheritMainContext ? "main" : "sub",
					source: "tool",
					batchId: config.batchId,
					pipelineId: config.pipelineId,
					pipelineStepIndex: config.pipelineStepIndex,
				};
				store.commandRuns.set(runId, runState);
			}

			runState.batchId = config.batchId;
			runState.pipelineId = config.pipelineId;
			runState.pipelineStepIndex = config.pipelineStepIndex;
			const abortController = new AbortController();
			runState.abortController = abortController;
			linkParentAbortSignal(runState.id, abortController);
			store.globalLiveRuns.set(runState.id, {
				runState,
				abortController,
				originSessionFile: config.originSessionFile,
			});
			store.recentLaunchTimestamps.set(runState.id, runState.startedAt);
			store.commandWidgetCtx = ctx as WidgetRenderCtx;
			updateCommandRunsWidget(store, ctx as WidgetRenderCtx);
			refreshDisplayTaskInBackground(runState, config.taskForDisplay, ctx, store);
			return runState;
		}

		function cleanupRunAfterFinalDelivery(runId: number) {
			clearParentAbortListener(runId);
			store.globalLiveRuns.delete(runId);
			store.recentLaunchTimestamps.delete(runId);
		}

		function launchRunInBackground(runState: CommandRunState, taskForAgent: string): Promise<FinalizedRun> {
			let claudeCheckpointSent = !!runState.claudeSessionId;
			return enqueueSubagentInvocation(() =>
				runSingleAgent(
					ctx.cwd,
					agents,
					runState.agent,
					taskForAgent,
					runState.pipelineStepIndex,
					runState.abortController?.signal,
					(partial) => {
						if (runState.removed) return;
						const current = partial.details?.results?.[0];
						if (!current) return;
						updateRunFromResult(runState, current);
						if (shouldRunAsync && !claudeCheckpointSent && runState.claudeSessionId) {
							claudeCheckpointSent = true;
							pi.sendMessage(buildRunStartMessage(runState, "started"), {
								deliverAs: "followUp",
								triggerTurn: false,
							});
						}
						updateCommandRunsWidget(store);
					},
					(results) => makeDetails(mode, results),
					{
						sessionFile: runState.sessionFile,
						resumeSessionId: runState.claudeSessionId,
						sidecarSessionFile: runState.sessionFile,
						persistedSessionBaseOffset: runState.persistedSessionBaseOffset,
					},
				),
			).then((result) => finalizeRunState(runState, result));
		}

		if (hasSingle) {
			const continuationRunId = Number.isInteger(cmdParams.runId) ? (cmdParams.runId as number) : undefined;
			let continueFromRun: CommandRunState | undefined;
			if (continuationRunId !== undefined) {
				continueFromRun = store.commandRuns.get(continuationRunId);
				if (!continueFromRun) {
					return {
						content: [
							{
								type: "text",
								text: withIdleRunWarning(
									`Unknown subagent run #${continuationRunId}. Use \`subagent runs\` to see available runs.`,
								),
							},
						],
						details: makeDetails("single"),
						isError: true,
					};
				}
				if (continueFromRun.status === "running") {
					return {
						content: [
							{
								type: "text",
								text: withIdleRunWarning(
									`Subagent #${continuationRunId} is still running. Wait for it to finish or abort it first.`,
								),
							},
						],
						details: makeDetails("single"),
						isError: true,
					};
				}

				if (continueFromRun.runtime === "claude") {
					if (!continueFromRun.claudeSessionId) {
						return {
							content: [
								{
									type: "text",
									text: `Cannot resume Claude run #${continuationRunId}: no claudeSessionId found. The session metadata was lost or never captured.`,
								},
							],
							details: makeDetails("single"),
							isError: true,
						};
					}
					if (!continueFromRun.claudeProjectDir || continueFromRun.claudeProjectDir !== ctx.cwd) {
						return {
							content: [
								{
									type: "text",
									text: `Cannot resume Claude run #${continuationRunId}: claudeProjectDir mismatch. Expected "${continueFromRun.claudeProjectDir ?? "(none)"}", current cwd is "${ctx.cwd}".`,
								},
							],
							details: makeDetails("single"),
							isError: true,
						};
					}
				}
			}

			const resolvedAgent = (cmdParams.agent ?? continueFromRun?.agent ?? "worker") as string;
			const rawTask = typeof cmdParams.task === "string" ? cmdParams.task : "";
			if (!rawTask.trim()) {
				return {
					content: [{ type: "text", text: withIdleRunWarning("subagent run/continue requires task.") }],
					details: makeDetails("single"),
					isError: true,
				};
			}

			const taskForDisplay = continueFromRun ? `[continue #${continueFromRun.id}] ${rawTask}` : rawTask;
			const taskForAgent = wrapTaskWithMainContext(rawTask, stripTaskEchoFromMainContext(mainContextText, rawTask), {
				mainSessionFile,
				totalMessageCount,
			});
			const runState = registerRunLaunch({
				agent: resolvedAgent,
				taskForDisplay,
				taskForAgent,
				inheritMainContext,
				originSessionFile,
				continuedFromRunId: continuationRunId,
				existingRunState: continueFromRun,
			});
			const launchSummary = toLaunchSummary(runState, continueFromRun ? "continue" : "run");
			const startedState = continueFromRun ? "resumed" : "started";

			if (!shouldRunAsync) {
				let finalized: FinalizedRun;
				try {
					finalized = await launchRunInBackground(runState, taskForAgent);
				} catch (error: unknown) {
					finalized = finalizeRunError(runState, error);
				} finally {
					clearRunAbortState(runState);
				}

				const message =
					finalized.result?.exitCode === ESCALATION_EXIT_CODE
						? buildEscalationMessage(runState, finalized.rawOutput.replace(/^\[ESCALATION\]\s*/, ""), finalized.result)
						: buildRunCompletionMessage(finalized);
				cleanupRunAfterFinalDelivery(runState.id);
				trimCommandRunHistory(store, {
					maxRuns: 10,
					ctx,
					pi,
					updateWidget: false,
					removalReason: "trim",
				});
				updateCommandRunsWidget(store);

				return {
					content: [{ type: "text", text: withIdleRunWarning(message.content) }],
					details: makeDetails("single", finalized.result ? [finalized.result] : [], [launchSummary]),
					isError: finalized.isError,
				};
			}

			pi.sendMessage(buildRunStartMessage(runState, startedState), { deliverAs: "followUp", triggerTurn: false });
			ctx.ui?.notify?.(
				`${continueFromRun ? `Resumed subagent #${runState.id}` : `Started subagent #${runState.id}`}: ${resolvedAgent}`,
				"info",
			);

			void (async () => {
				try {
					const finalized = await launchRunInBackground(runState, taskForAgent);
					if (runState.removed) return;
					updateCommandRunsWidget(store);

					if (finalized.result?.exitCode === ESCALATION_EXIT_CODE) {
						const escalationMsg = finalized.rawOutput.replace(/^\[ESCALATION\]\s*/, "");
						const message = buildEscalationMessage(runState, escalationMsg, finalized.result);
						if (isInOriginSession(ctx, originSessionFile)) {
							pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
							cleanupRunAfterFinalDelivery(runState.id);
						} else {
							const entry = store.globalLiveRuns.get(runState.id);
							if (entry) entry.pendingCompletion = makePendingCompletion(message, true);
						}
						return;
					}

					const completionMessage = buildRunCompletionMessage(finalized);
					if (isInOriginSession(ctx, originSessionFile)) {
						pi.sendMessage(completionMessage, { deliverAs: "followUp", triggerTurn: true });
						cleanupRunAfterFinalDelivery(runState.id);
					} else {
						const entry = store.globalLiveRuns.get(runState.id);
						if (entry) entry.pendingCompletion = makePendingCompletion(completionMessage, true);
					}

					ctx.ui?.notify?.(
						finalized.isError
							? `subagent tool run #${runState.id} (${resolvedAgent}) failed`
							: `subagent tool run #${runState.id} (${resolvedAgent}) completed`,
						finalized.isError ? "error" : "info",
					);
				} catch (error: unknown) {
					if (runState.removed) return;
					const finalized = finalizeRunError(runState, error);
					const errorMessage = buildRunCompletionMessage(finalized);
					if (isInOriginSession(ctx, originSessionFile)) {
						pi.sendMessage(errorMessage, { deliverAs: "followUp", triggerTurn: true });
						cleanupRunAfterFinalDelivery(runState.id);
					} else {
						const entry = store.globalLiveRuns.get(runState.id);
						if (entry) entry.pendingCompletion = makePendingCompletion(errorMessage, true);
					}
					ctx.ui?.notify?.(`subagent tool run #${runState.id} failed: ${runState.lastLine}`, "error");
					updateCommandRunsWidget(store);
				} finally {
					clearRunAbortState(runState);
					trimCommandRunHistory(store, {
						maxRuns: 10,
						ctx,
						pi,
						updateWidget: false,
						removalReason: "trim",
					});
					updateCommandRunsWidget(store);
				}
			})();

			return {
				content: [
					{
						type: "text",
						text: withIdleRunWarning(
							`${continueFromRun ? `Resumed async subagent run #${runState.id}` : `Started async subagent run #${runState.id}`} (${resolvedAgent}). ${SUBAGENT_STRONG_WAIT_MESSAGE}`,
						),
					},
				],
				details: makeDetails("single", [], [launchSummary]),
			};
		}

		if (hasBatch) {
			const runs = Array.isArray(cmdParams.runs) ? (cmdParams.runs as BatchOrChainItem[]) : [];
			if (runs.length < 2) {
				return {
					content: [{ type: "text", text: "batch requires at least 2 runs." }],
					details: makeDetails("batch"),
					isError: true,
				};
			}
			if (runs.length > MAX_BATCH_RUNS) {
				return {
					content: [{ type: "text", text: `batch supports at most ${MAX_BATCH_RUNS} runs.` }],
					details: makeDetails("batch"),
					isError: true,
				};
			}

			const batchId = `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
			const runStates = runs.map((item, index) => {
				const taskForAgent = wrapTaskWithMainContext(
					item.task,
					stripTaskEchoFromMainContext(mainContextText, item.task),
					{ mainSessionFile, totalMessageCount },
				);
				const runState = registerRunLaunch({
					agent: item.agent,
					taskForDisplay: item.task,
					taskForAgent,
					inheritMainContext,
					originSessionFile,
					batchId,
					pipelineStepIndex: index,
				});
				return { runState, taskForAgent };
			});

			store.batchGroups.set(batchId, {
				batchId,
				runIds: runStates.map(({ runState }) => runState.id),
				completedRunIds: new Set(),
				failedRunIds: new Set(),
				originSessionFile,
				createdAt: Date.now(),
				pendingResults: new Map(),
			});
			updateCommandRunsWidget(store, ctx as WidgetRenderCtx);

			if (!shouldRunAsync) {
				const finalizedRuns = await Promise.all(
					runStates.map(async ({ runState, taskForAgent }) => {
						try {
							return await launchRunInBackground(runState, taskForAgent);
						} catch (error: unknown) {
							return finalizeRunError(runState, error);
						} finally {
							clearRunAbortState(runState);
						}
					}),
				);
				const orderedRuns = runStates.map(({ runState }) => runState);
				const hasError = finalizedRuns.some((finalized) => finalized.isError);
				const content = formatBatchSummary(batchId, orderedRuns, hasError ? "error" : "completed");
				for (const { runState } of runStates) cleanupRunAfterFinalDelivery(runState.id);
				clearPendingGroupCompletion("batch", batchId);
				store.batchGroups.delete(batchId);
				trimCommandRunHistory(store, {
					maxRuns: 10,
					ctx,
					pi,
					updateWidget: false,
					removalReason: "trim",
				});
				updateCommandRunsWidget(store);

				return {
					content: [{ type: "text", text: withIdleRunWarning(content) }],
					details: makeDetails(
						"batch",
						finalizedRuns
							.map((finalized) => finalized.result)
							.filter((result): result is SingleResult => Boolean(result)),
						runStates.map(({ runState }) => toLaunchSummary(runState, "batch")),
					),
					isError: hasError,
				};
			}

			for (const { runState, taskForAgent } of runStates) {
				void (async () => {
					try {
						const finalized = await launchRunInBackground(runState, taskForAgent);

						const batch = store.batchGroups.get(batchId);
						if (!batch) return;
						batch.completedRunIds.add(runState.id);
						if (finalized.isError) batch.failedRunIds.add(runState.id);
						batch.pendingResults.set(runState.id, finalized.rawOutput);
						updateCommandRunsWidget(store);

						if (batch.completedRunIds.size === batch.runIds.length) {
							const orderedRuns = batch.runIds
								.map((runId) => store.commandRuns.get(runId))
								.filter((run): run is CommandRunState => Boolean(run));
							const batchTerminalStatus = batch.failedRunIds.size > 0 ? "error" : "completed";
							const content = formatBatchSummary(batchId, orderedRuns, batchTerminalStatus);
							const message = {
								customType: "subagent-tool" as const,
								content,
								display: true,
								details: {
									batchId,
									runIds: batch.runIds,
									status: batch.failedRunIds.size > 0 ? "error" : "done",
									runSummaries: orderedRuns.map((run) => buildRunAnalyticsSummary(run)),
								},
							};
							if (isInOriginSession(ctx, batch.originSessionFile)) {
								pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
								clearPendingGroupCompletion("batch", batchId);
								for (const runId of batch.runIds) cleanupRunAfterFinalDelivery(runId);
								store.batchGroups.delete(batchId);
							} else {
								batch.pendingCompletion = makePendingCompletion(message, true);
								upsertPendingGroupCompletion({
									scope: "batch",
									groupId: batchId,
									originSessionFile: batch.originSessionFile,
									runIds: batch.runIds,
									pendingCompletion: batch.pendingCompletion,
								});
							}
							trimCommandRunHistory(store, {
								maxRuns: 10,
								ctx,
								pi,
								updateWidget: false,
								removalReason: "trim",
							});
							ctx.ui?.notify?.(
								batch.failedRunIds.size > 0
									? `subagent batch ${batchId} finished with errors`
									: `subagent batch ${batchId} completed`,
								batch.failedRunIds.size > 0 ? "error" : "info",
							);
						}
					} catch (error: unknown) {
						runState.status = "error";
						runState.elapsedMs = Date.now() - runState.startedAt;
						runState.lastLine = error instanceof Error ? error.message : "Subagent execution failed";
						runState.lastOutput = runState.lastLine;
						const batch = store.batchGroups.get(batchId);
						if (!batch) return;
						batch.completedRunIds.add(runState.id);
						batch.failedRunIds.add(runState.id);
						batch.pendingResults.set(runState.id, runState.lastLine);
						if (batch.completedRunIds.size === batch.runIds.length) {
							const orderedRuns = batch.runIds
								.map((runId) => store.commandRuns.get(runId))
								.filter((run): run is CommandRunState => Boolean(run));
							const message = {
								customType: "subagent-tool" as const,
								content: formatBatchSummary(batchId, orderedRuns, "error"),
								display: true,
								details: {
									batchId,
									runIds: batch.runIds,
									status: "error",
									runSummaries: orderedRuns.map((run) => buildRunAnalyticsSummary(run)),
								},
							};
							if (isInOriginSession(ctx, batch.originSessionFile)) {
								pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
								clearPendingGroupCompletion("batch", batchId);
								for (const runId of batch.runIds) cleanupRunAfterFinalDelivery(runId);
								store.batchGroups.delete(batchId);
							} else {
								batch.pendingCompletion = makePendingCompletion(message, true);
								upsertPendingGroupCompletion({
									scope: "batch",
									groupId: batchId,
									originSessionFile: batch.originSessionFile,
									runIds: batch.runIds,
									pendingCompletion: batch.pendingCompletion,
								});
							}
						}
						updateCommandRunsWidget(store);
					}
				})();
			}

			return {
				content: [
					{
						type: "text",
						text: withIdleRunWarning(
							`Started async subagent batch ${batchId} (${runStates.length} runs). ${SUBAGENT_STRONG_WAIT_MESSAGE}`,
						),
					},
				],
				details: makeDetails(
					"batch",
					[],
					runStates.map(({ runState }) => toLaunchSummary(runState, "batch")),
				),
			};
		}

		if (hasChain) {
			const steps = Array.isArray(cmdParams.steps) ? (cmdParams.steps as BatchOrChainItem[]) : [];
			if (steps.length < 2) {
				return {
					content: [{ type: "text", text: "chain requires at least 2 steps." }],
					details: makeDetails("chain"),
					isError: true,
				};
			}
			if (steps.length > MAX_CHAIN_STEPS) {
				return {
					content: [{ type: "text", text: `chain supports at most ${MAX_CHAIN_STEPS} steps.` }],
					details: makeDetails("chain"),
					isError: true,
				};
			}

			const pipelineId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
			const chainLaunches: SubagentLaunchSummary[] = [];
			store.pipelines.set(pipelineId, {
				pipelineId,
				currentIndex: 0,
				stepRunIds: [],
				stepResults: [],
				originSessionFile,
				createdAt: Date.now(),
			});

			if (!shouldRunAsync) {
				let previousOutput = "";
				let terminalStatus: "completed" | "stopped" | "error" = "completed";
				const finalizedRuns: FinalizedRun[] = [];
				const pipeline = store.pipelines.get(pipelineId);
				if (!pipeline) {
					return {
						content: [{ type: "text", text: "Subagent chain failed to initialize." }],
						details: makeDetails("chain"),
						isError: true,
					};
				}

				try {
					for (let index = 0; index < steps.length; index++) {
						pipeline.currentIndex = index;
						const step = steps[index];
						const pipelineReferenceSection =
							index > 0
								? buildPipelineReferenceSection(previousOutput, {
										agent: steps[index - 1]?.agent,
										task: steps[index - 1]?.task,
										stepNumber: index,
										totalSteps: steps.length,
									})
								: "";
						let taskForAgent = step.task;
						if (inheritMainContext) {
							taskForAgent = wrapTaskWithMainContext(
								step.task,
								stripTaskEchoFromMainContext(mainContextText, step.task),
								{
									mainSessionFile,
									totalMessageCount,
									referenceSections: pipelineReferenceSection ? [pipelineReferenceSection] : undefined,
								},
							);
						} else if (pipelineReferenceSection) {
							taskForAgent = wrapTaskWithPipelineContext(step.task, previousOutput, {
								agent: steps[index - 1]?.agent,
								task: steps[index - 1]?.task,
								stepNumber: index,
								totalSteps: steps.length,
							});
						}

						const runState = registerRunLaunch({
							agent: step.agent,
							taskForDisplay: step.task,
							taskForAgent,
							inheritMainContext,
							originSessionFile,
							pipelineId,
							pipelineStepIndex: index,
						});
						pipeline.stepRunIds.push(runState.id);
						chainLaunches.push(toLaunchSummary(runState, "chain"));

						let finalized: FinalizedRun;
						try {
							finalized = await launchRunInBackground(runState, taskForAgent);
						} catch (error: unknown) {
							finalized = finalizeRunError(runState, error);
						} finally {
							clearRunAbortState(runState);
						}
						finalizedRuns.push(finalized);

						if (runState.removed) {
							terminalStatus = finalized.isError ? "error" : "stopped";
							pipeline.stepResults.push({
								runId: runState.id,
								agent: runState.agent,
								task: step.task,
								output: finalized.rawOutput || "Run removed before pipeline completion.",
								status: "error",
							});
							break;
						}

						pipeline.stepResults.push({
							runId: runState.id,
							agent: runState.agent,
							task: step.task,
							output: finalized.rawOutput,
							status: finalized.isError ? "error" : "done",
						});
						previousOutput = finalized.rawOutput;
						updateCommandRunsWidget(store);

						if (finalized.isError) {
							terminalStatus = "error";
							break;
						}
					}
				} catch (error: unknown) {
					terminalStatus = "error";
					pipeline.stepResults.push({
						runId: -1,
						agent: "pipeline",
						task: "internal error",
						output: error instanceof Error ? error.message : "Subagent execution failed",
						status: "error",
					});
				}

				const hasError = pipeline.stepResults.some((step) => step.status === "error");
				if (terminalStatus === "completed" && hasError) terminalStatus = "error";
				const content = formatPipelineSummary(pipelineId, pipeline.stepResults, terminalStatus);
				for (const runId of pipeline.stepRunIds) cleanupRunAfterFinalDelivery(runId);
				clearPendingGroupCompletion("chain", pipelineId);
				store.pipelines.delete(pipelineId);
				trimCommandRunHistory(store, {
					maxRuns: 10,
					ctx,
					pi,
					updateWidget: false,
					removalReason: "trim",
				});
				updateCommandRunsWidget(store);

				return {
					content: [{ type: "text", text: withIdleRunWarning(content) }],
					details: makeDetails(
						"chain",
						finalizedRuns
							.map((finalized) => finalized.result)
							.filter((result): result is SingleResult => Boolean(result)),
						[...chainLaunches],
					),
					isError: terminalStatus !== "completed",
				};
			}

			void (async () => {
				let previousOutput = "";
				let terminalStatus: "completed" | "stopped" | "error" = "completed";
				try {
					for (let index = 0; index < steps.length; index++) {
						const pipeline = store.pipelines.get(pipelineId);
						if (!pipeline) return;
						pipeline.currentIndex = index;

						const step = steps[index];
						const pipelineReferenceSection =
							index > 0
								? buildPipelineReferenceSection(previousOutput, {
										agent: steps[index - 1]?.agent,
										task: steps[index - 1]?.task,
										stepNumber: index,
										totalSteps: steps.length,
									})
								: "";
						let taskForAgent = step.task;
						if (inheritMainContext) {
							taskForAgent = wrapTaskWithMainContext(
								step.task,
								stripTaskEchoFromMainContext(mainContextText, step.task),
								{
									mainSessionFile,
									totalMessageCount,
									referenceSections: pipelineReferenceSection ? [pipelineReferenceSection] : undefined,
								},
							);
						} else if (pipelineReferenceSection) {
							taskForAgent = wrapTaskWithPipelineContext(step.task, previousOutput, {
								agent: steps[index - 1]?.agent,
								task: steps[index - 1]?.task,
								stepNumber: index,
								totalSteps: steps.length,
							});
						}

						const runState = registerRunLaunch({
							agent: step.agent,
							taskForDisplay: step.task,
							taskForAgent,
							inheritMainContext,
							originSessionFile,
							pipelineId,
							pipelineStepIndex: index,
						});
						pipeline.stepRunIds.push(runState.id);
						chainLaunches.push(toLaunchSummary(runState, "chain"));

						const finalized = await launchRunInBackground(runState, taskForAgent);
						if (runState.removed) {
							terminalStatus = finalized.isError ? "error" : "stopped";
							pipeline.stepResults.push({
								runId: runState.id,
								agent: runState.agent,
								task: step.task,
								output: finalized.rawOutput || "Run removed before pipeline completion.",
								status: "error",
							});
							break;
						}

						const stepResult: PipelineStepResult = {
							runId: runState.id,
							agent: runState.agent,
							task: step.task,
							output: finalized.rawOutput,
							status: finalized.isError ? "error" : "done",
						};
						pipeline.stepResults.push(stepResult);
						previousOutput = finalized.rawOutput;
						updateCommandRunsWidget(store);

						if (finalized.isError) {
							terminalStatus = "error";
							break;
						}
					}
				} catch (error: unknown) {
					terminalStatus = "error";
					const pipeline = store.pipelines.get(pipelineId);
					if (pipeline) {
						pipeline.stepResults.push({
							runId: -1,
							agent: "pipeline",
							task: "internal error",
							output: error instanceof Error ? error.message : "Subagent execution failed",
							status: "error",
						});
					}
				} finally {
					const pipeline = store.pipelines.get(pipelineId);
					if (pipeline) {
						const hasError = pipeline.stepResults.some((step) => step.status === "error");
						if (terminalStatus === "completed" && hasError) {
							terminalStatus = "error";
						}
						const orderedRuns = pipeline.stepRunIds
							.map((runId) => store.commandRuns.get(runId))
							.filter((run): run is CommandRunState => Boolean(run));
						const message = {
							customType: "subagent-tool" as const,
							content: formatPipelineSummary(pipelineId, pipeline.stepResults, terminalStatus),
							display: true,
							details: {
								pipelineId,
								stepRunIds: pipeline.stepRunIds,
								status: terminalStatus === "completed" ? "done" : terminalStatus,
								runSummaries: orderedRuns.map((run) => buildRunAnalyticsSummary(run)),
							},
						};
						if (isInOriginSession(ctx, pipeline.originSessionFile)) {
							pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
							clearPendingGroupCompletion("chain", pipelineId);
							for (const runId of pipeline.stepRunIds) cleanupRunAfterFinalDelivery(runId);
							store.pipelines.delete(pipelineId);
						} else {
							pipeline.pendingCompletion = makePendingCompletion(message, true);
							upsertPendingGroupCompletion({
								scope: "chain",
								groupId: pipelineId,
								originSessionFile: pipeline.originSessionFile,
								runIds: pipeline.stepRunIds,
								pendingCompletion: pipeline.pendingCompletion,
							});
						}
						trimCommandRunHistory(store, {
							maxRuns: 10,
							ctx,
							pi,
							updateWidget: false,
							removalReason: "trim",
						});
					}
					updateCommandRunsWidget(store);
				}
			})();

			return {
				content: [
					{
						type: "text",
						text: withIdleRunWarning(
							`Started async subagent chain ${pipelineId} (${steps.length} steps). ${SUBAGENT_STRONG_WAIT_MESSAGE}`,
						),
					},
				],
				details: makeDetails("chain", [], [...chainLaunches]),
			};
		}

		return {
			content: [{ type: "text", text: withIdleRunWarning("Invalid subagent invocation.") }],
			details: makeDetails(),
			isError: true,
		};
	};

	return execute;
}
