/**
 * Type definitions, interfaces, and Typebox schemas for the Subagent tool.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentConfig, AgentRuntime } from "./agents.js";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	liveText?: string;
	liveThinking?: string;
	liveToolCalls?: number;
	thoughtText?: string;
	sessionFile?: string;
	runtime?: AgentRuntime;
	claudeSessionId?: string;
	claudeProjectDir?: string;
	liveActivityPreview?: string;
}

export interface BatchOrChainItem {
	agent: string;
	task: string;
}

export interface SubagentLaunchSummary {
	agent: string;
	mode: "run" | "continue" | "batch" | "chain";
	runId?: number;
	batchId?: string;
	pipelineId?: string;
	stepIndex?: number;
}

export interface SubagentDetails {
	mode: "single" | "batch" | "chain";
	inheritMainContext: boolean;
	projectAgentsDir: string | null;
	results: SingleResult[];
	launches?: SubagentLaunchSummary[];
}

export interface CommandRunState {
	id: number;
	agent: string;
	task: string;
	displayTask?: string;
	status: "running" | "done" | "error";
	startedAt: number;
	elapsedMs: number;
	toolCalls: number;
	lastLine: string;
	lastOutput?: string;
	continuedFromRunId?: number;
	turnCount: number;
	sessionFile?: string;
	persistedSessionBaseOffset?: number;
	abortController?: AbortController;
	usage?: UsageStats;
	model?: string;
	removed?: boolean;
	contextMode?: "main" | "sub";
	thoughtText?: string;
	/** Timestamp of last detected activity (tool call / turn / liveText change). Used for hang detection. */
	lastActivityAt: number;
	/** Number of auto-retries already attempted for this run. */
	retryCount?: number;
	/** Last transient failure reason that triggered an auto-retry. */
	lastRetryReason?: string;
	runtime?: AgentRuntime;
	claudeSessionId?: string;
	claudeProjectDir?: string;
	/** Origin of this run: "tool" = LLM called subagent tool, "command" = user slash-command / >> shorthand. */
	source?: "tool" | "command";
	/** Optional batch group id for tool-level grouped parallel launches. */
	batchId?: string;
	/** Optional pipeline id for tool-level sequential launches. */
	pipelineId?: string;
	/** Zero-based step index inside batch/pipeline metadata. */
	pipelineStepIndex?: number;
	/** How completion/start events should be surfaced back to the user. */
	deliveryMode?: "followUp" | "humanOnly";
}

export interface SessionReplayItem {
	type: "user" | "assistant" | "tool";
	title: string;
	content: string;
	timestamp: Date;
	elapsed?: string;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface AgentAliasMatch {
	matchedAgent?: AgentConfig;
	ambiguousAgents: AgentConfig[];
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Pending completion message stored when a run finishes while the user
 * is in a different session from where the run originated.
 */
export interface PendingCompletion {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details: Record<string, unknown>;
	};
	options: {
		deliverAs: "followUp";
		triggerTurn?: boolean;
	};
	createdAt: number;
}

/**
 * Global live run entry — tracks a running subagent process independently
 * of the session lifecycle. Lives in a module-level Map that is never
 * cleared by session switches.
 */
export interface GlobalRunEntry {
	runState: CommandRunState;
	abortController: AbortController;
	originSessionFile: string;
	/** Set when the run completes while the user is in a different session. */
	pendingCompletion?: PendingCompletion;
}

export interface BatchGroupState {
	batchId: string;
	runIds: number[];
	completedRunIds: Set<number>;
	failedRunIds: Set<number>;
	originSessionFile: string;
	createdAt: number;
	pendingResults: Map<number, string>;
	pendingCompletion?: PendingCompletion;
}

export interface PipelineStepResult {
	runId: number;
	agent: string;
	task: string;
	output: string;
	status: "done" | "error";
}

export interface PipelineState {
	pipelineId: string;
	currentIndex: number;
	stepRunIds: number[];
	stepResults: PipelineStepResult[];
	originSessionFile: string;
	createdAt: number;
	pendingCompletion?: PendingCompletion;
}

export const ListAgentsParams = Type.Object({});

export const SubagentParams = Type.Object({
	command: Type.String({
		description:
			"Command string, e.g. 'subagent help', 'subagent run worker --main -- <task>', 'subagent batch --main --agent worker --task \"A\" --agent reviewer --task \"B\"'. Write long task context to a temp file and reference its path.",
	}),
});
