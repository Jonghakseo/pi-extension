/**
 * Shared state store and state-mutation helpers for the Subagent extension.
 */

import type { Message } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getDisplayItems, getFinalOutput, getLastNonEmptyLine, getLatestActivityPreview } from "./runner.js";
import type {
	BatchGroupState,
	CommandRunState,
	FinishedGroupSnapshot,
	GlobalRunEntry,
	PipelineState,
	SingleResult,
} from "./types.js";
import type { WidgetRenderCtx } from "./widget.js";

export const COLLAPSED_ITEM_COUNT = 10;

export interface SubagentStore {
	/** True after session_shutdown; async callbacks must not use captured runtime APIs. */
	disposed: boolean;
	commandRuns: Map<number, CommandRunState>;
	/**
	 * Live run registry for the current extension runtime. Pi session replacement
	 * tears down that runtime, so session_shutdown aborts and clears these entries.
	 */
	globalLiveRuns: Map<number, GlobalRunEntry>;
	renderedRunWidgetIds: Set<number>;
	nextCommandRunId: number;
	commandWidgetCtx: WidgetRenderCtx | null;
	/** Context reference for the legacy above-editor pixel widget. */
	pixelWidgetCtx: Pick<WidgetRenderCtx, "hasUI" | "ui"> | null;
	/** @deprecated Kept for backward compat; persistent parent link now used instead. */
	sessionStack: string[];
	/** Captured switchSession from ExtensionCommandContext (for use in input handlers). */
	switchSessionFn: ((sessionPath: string) => Promise<{ cancelled: boolean }>) | null;
	/** Persistent parent session file path, restored from session entries. Null when at root. */
	currentParentSessionFile: string | null;
	/** Legacy snapshot fallback for hosts that re-emit session_start on one runtime. */
	sessionRunCache: Map<string, CommandRunState[]>;
	/** Last active session file path for snapshot bookkeeping. */
	currentSessionFile: string | null;
	/** Timestamp of the most recent launch/resume per run for anti-polling cooldown checks. */
	recentLaunchTimestamps: Map<number, number>;
	/** In-memory grouped parallel batch runs launched via the tool. */
	batchGroups: Map<string, BatchGroupState>;
	/** In-memory sequential pipelines launched via the tool. */
	pipelines: Map<string, PipelineState>;
	/** Retained snapshots of finished batch/chain groups, keyed by groupId (insertion-ordered). */
	finishedGroups: Map<string, FinishedGroupSnapshot>;
}

export function createStore(): SubagentStore {
	return {
		disposed: false,
		commandRuns: new Map(),
		globalLiveRuns: new Map(),
		renderedRunWidgetIds: new Set(),
		nextCommandRunId: 1,
		commandWidgetCtx: null,
		pixelWidgetCtx: null,
		sessionStack: [],
		switchSessionFn: null,
		currentParentSessionFile: null,
		sessionRunCache: new Map(),
		currentSessionFile: null,
		recentLaunchTimestamps: new Map(),
		batchGroups: new Map(),
		pipelines: new Map(),
		finishedGroups: new Map(),
	};
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sliceToDisplayWidth(value: string, maxWidth: number): string {
	if (maxWidth <= 0 || value.length === 0) return "";

	let result = "";
	let width = 0;

	for (const { segment } of graphemeSegmenter.segment(value)) {
		const segmentWidth = visibleWidth(segment);
		if (segmentWidth <= 0) {
			result += segment;
			continue;
		}
		if (width + segmentWidth > maxWidth) break;
		result += segment;
		width += segmentWidth;
	}

	return result;
}

export function truncateText(value: string, max: number): string {
	if (max <= 0 || value.length === 0) return "";
	if (visibleWidth(value) <= max) return value;
	if (max <= 3) return sliceToDisplayWidth(value, max);
	return `${sliceToDisplayWidth(value, max - 3)}...`;
}

export function collectToolCallCount(messages: Message[]): number {
	return getDisplayItems(messages).filter((item) => item.type === "toolCall").length;
}

function resolveLastLine(result: SingleResult, output: string | undefined): string | undefined {
	if (result.liveActivityPreview) return result.liveActivityPreview;
	const previewLine = getLatestActivityPreview(result.messages);
	if (previewLine) return previewLine;
	if (result.liveText) {
		const liveLine = getLastNonEmptyLine(result.liveText);
		if (liveLine) return liveLine;
	}
	if (output) return getLastNonEmptyLine(output);
	return undefined;
}

export function updateRunFromResult(state: CommandRunState, result: SingleResult): void {
	const prevToolCalls = state.toolCalls;
	const prevTurnCount = state.turnCount;
	const prevLastLine = state.lastLine;
	const prevThoughtText = state.thoughtText;

	state.elapsedMs = Date.now() - state.startedAt;
	state.toolCalls = Math.max(collectToolCallCount(result.messages), result.liveToolCalls ?? 0);
	state.usage = result.usage;
	state.model = result.model ?? state.model;
	if (result.usage?.turns != null) state.turnCount = result.usage.turns;
	if (result.thoughtText) state.thoughtText = result.thoughtText;

	if (result.runtime) state.runtime = result.runtime;
	if (result.claudeSessionId) state.claudeSessionId = result.claudeSessionId;
	if (result.claudeProjectDir) state.claudeProjectDir = result.claudeProjectDir;

	const output = getFinalOutput(result.messages);
	if (output) state.lastOutput = output;

	const resolved = resolveLastLine(result, output);
	if (resolved) state.lastLine = resolved;

	const hasDisplayChange =
		state.toolCalls !== prevToolCalls ||
		state.turnCount !== prevTurnCount ||
		state.lastLine !== prevLastLine ||
		state.thoughtText !== prevThoughtText;
	const hasLiveStreamActivity =
		result.liveActivityPreview != null || result.liveText != null || result.liveThinking != null;
	if (hasDisplayChange || hasLiveStreamActivity) {
		state.lastActivityAt = Date.now();
	}
}
