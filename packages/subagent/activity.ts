/**
 * Throttled `subagent-activity` custom entries.
 *
 * Lets host UIs (e.g. Picky) observe live activity of headless subagent runs
 * by appending change-driven, throttled entries to the parent session JSONL.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CommandRunState } from "./types.js";

export const SUBAGENT_ACTIVITY_CUSTOM_TYPE = "subagent-activity";
export const SUBAGENT_ACTIVITY_SCHEMA_VERSION = 1;
export const ACTIVITY_MIN_INTERVAL_MS = 2500;
export const ACTIVITY_LAST_LINE_MAX_CHARS = 160;

export interface ActivitySnapshot {
	status: CommandRunState["status"];
	runId: number;
	agent: string;
	batchId?: string;
	pipelineId?: string;
	pipelineStepIndex?: number;
	lastToolName?: string;
	toolCallCount: number;
	lastLine?: string;
	contextTokens?: number;
}

export interface ActivityPayload {
	runId: number;
	agent: string;
	batchId?: string;
	pipelineId?: string;
	pipelineStepIndex?: number;
	lastToolName?: string;
	toolCallCount: number;
	lastLine?: string;
	contextTokens?: number;
}

export interface ActivityThrottleState {
	lastEmittedAt: number;
	lastEmittedToolName?: string;
	lastEmittedToolCallCount?: number;
}

export function createActivityThrottleState(): ActivityThrottleState {
	return { lastEmittedAt: 0 };
}

const ANSI_PATTERN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences use control characters by definition.
	/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Strip ANSI sequences, collapse to a single line, and cap length. */
export function normalizeActivityLine(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const line = text
		.replace(/\r\n?/g, "\n")
		.replace(ANSI_PATTERN, "")
		.split("\n")
		.map((part) => part.trim())
		.filter(Boolean)
		.pop();
	if (!line) return undefined;
	return line.length > ACTIVITY_LAST_LINE_MAX_CHARS ? line.slice(0, ACTIVITY_LAST_LINE_MAX_CHARS) : line;
}

/**
 * Change-driven throttle policy. Returns a payload to emit, or null.
 *
 * Emits only while the run is `running`, only when `lastToolName` or
 * `toolCallCount` changed since the last emission, and at most once per
 * `ACTIVITY_MIN_INTERVAL_MS` per run. A change suppressed by the interval
 * stays pending and emits on a later evaluation.
 */
export function evaluateActivityEmission(
	state: ActivityThrottleState,
	snapshot: ActivitySnapshot,
	now: number,
): ActivityPayload | null {
	if (snapshot.status !== "running") return null;
	// Continuations reset toolCalls to 0 while a stale lastToolName may linger
	// on the run state, so a positive count is required regardless of the name.
	if (snapshot.toolCallCount <= 0) return null;

	const changed =
		snapshot.lastToolName !== state.lastEmittedToolName || snapshot.toolCallCount !== state.lastEmittedToolCallCount;
	if (!changed) return null;
	if (state.lastEmittedAt !== 0 && now - state.lastEmittedAt < ACTIVITY_MIN_INTERVAL_MS) return null;

	state.lastEmittedAt = now;
	state.lastEmittedToolName = snapshot.lastToolName;
	state.lastEmittedToolCallCount = snapshot.toolCallCount;

	const payload: ActivityPayload = {
		runId: snapshot.runId,
		agent: snapshot.agent,
		toolCallCount: snapshot.toolCallCount,
	};
	if (snapshot.batchId) payload.batchId = snapshot.batchId;
	if (snapshot.pipelineId) payload.pipelineId = snapshot.pipelineId;
	if (snapshot.pipelineStepIndex != null) payload.pipelineStepIndex = snapshot.pipelineStepIndex;
	if (snapshot.lastToolName) payload.lastToolName = snapshot.lastToolName;
	const lastLine = normalizeActivityLine(snapshot.lastLine);
	if (lastLine) payload.lastLine = lastLine;
	if (snapshot.contextTokens != null && snapshot.contextTokens > 0) payload.contextTokens = snapshot.contextTokens;
	return payload;
}

export function snapshotFromRunState(runState: CommandRunState): ActivitySnapshot {
	return {
		status: runState.status,
		runId: runState.id,
		agent: runState.agent,
		batchId: runState.batchId,
		pipelineId: runState.pipelineId,
		pipelineStepIndex: runState.pipelineStepIndex,
		lastToolName: runState.lastToolName,
		toolCallCount: runState.toolCalls,
		lastLine: runState.lastLine,
		contextTokens: runState.usage?.contextTokens,
	};
}

/**
 * Best-effort recorder called from run update handlers. Never throws;
 * activity logging must not affect run execution or completion delivery.
 */
export function createRunActivityRecorder(
	pi: Pick<ExtensionAPI, "appendEntry">,
	runState: CommandRunState,
): () => void {
	const throttleState = createActivityThrottleState();
	return () => {
		try {
			const payload = evaluateActivityEmission(throttleState, snapshotFromRunState(runState), Date.now());
			if (!payload) return;
			pi.appendEntry(SUBAGENT_ACTIVITY_CUSTOM_TYPE, {
				schemaVersion: SUBAGENT_ACTIVITY_SCHEMA_VERSION,
				recordedAt: new Date().toISOString(),
				...payload,
			});
		} catch {
			// Session teardown may invalidate the old extension runtime.
		}
	};
}
