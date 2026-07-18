/**
 * Shared utilities for formatting and managing subagent command runs.
 *
 * Extracted from commands.ts to eliminate duplicated run-summary and
 * run-history-trimming logic. Output format is intentionally kept
 * identical to the original inline implementations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FINISHED_GROUP_TTL_MS, MAX_FINISHED_GROUPS, STATUS_OUTPUT_PREVIEW_MAX_CHARS } from "./constants.js";
import type { SubagentStore } from "./store.js";
import type {
	BatchGroupState,
	CommandRunState,
	FinishedGroupMember,
	FinishedGroupSnapshot,
	PipelineState,
} from "./types.js";
import { updateCommandRunsWidget, type WidgetRenderCtx } from "./widget.js";

export interface RemoveRunOptions {
	ctx?: unknown;
	pi?: ExtensionAPI;
	abortIfRunning?: boolean;
	reason?: string;
	persistRemovedEntry?: boolean;
	updateWidget?: boolean;
	removalReason?: string;
}

export interface RemoveRunResult {
	removed: boolean;
	aborted: boolean;
}

export interface TrimCommandRunHistoryOptions {
	maxRuns?: number;
	ctx?: unknown;
	pi?: ExtensionAPI;
	updateWidget?: boolean;
	removalReason?: string;
}

export interface ClearFinishedRunsOptions {
	ctx?: unknown;
	pi?: ExtensionAPI;
	updateWidget?: boolean;
	persistRemovedEntry?: boolean;
	removalReason?: string;
}

/**
 * One-line summary of a command run.
 *
 * Format: `#<id> [<status>] <agent> ctx:<contextMode> turn:<turnCount> <elapsed>s tools:<toolCalls>`
 */
export function formatCommandRunSummary(run: CommandRunState): string {
	const elapsedSec = Math.max(0, Math.round(run.elapsedMs / 1000));
	const contextLabel = run.contextMode === "main" ? "main" : "isolated";
	return `#${run.id} [${run.status}] ${run.agent} ctx:${contextLabel} turn:${run.turnCount ?? 1} ${elapsedSec}s tools:${run.toolCalls}`;
}

/**
 * Return the most recent run matching the optional status filter.
 * Runs are ordered by descending ID (newest first).
 * If no filter is given, the newest run overall is returned.
 */
export function getLatestRun(
	store: SubagentStore,
	statusFilter?: CommandRunState["status"] | CommandRunState["status"][],
): CommandRunState | undefined {
	const runs = Array.from(store.commandRuns.values()).sort((a, b) => b.id - a.id);
	if (!statusFilter) return runs[0];
	const allowed = Array.isArray(statusFilter) ? statusFilter : [statusFilter];
	return runs.find((r) => allowed.includes(r.status));
}

/**
 * Remove a run from the in-memory store with optional abort/persist side-effects.
 * This is the single deletion path used by commands/tool/trim logic.
 * Also cleans up the globalLiveRuns registry to prevent leaks.
 */
export function removeRun(store: SubagentStore, runId: number, options: RemoveRunOptions = {}): RemoveRunResult {
	const run = store.commandRuns.get(runId);
	if (!run) return { removed: false, aborted: false };

	const abortIfRunning = options.abortIfRunning ?? true;
	const persistRemovedEntry = options.persistRemovedEntry ?? true;
	const shouldUpdateWidget = options.updateWidget ?? true;
	let aborted = false;

	run.removed = true;

	// Abort via globalLiveRuns if the view state lost its controller reference.
	const globalEntry = store.globalLiveRuns.get(runId);
	const controller = run.abortController ?? globalEntry?.abortController;

	if (abortIfRunning && run.status === "running" && controller) {
		const reason = options.reason ?? "Aborting by remove...";
		run.lastLine = reason;
		run.lastOutput = reason;
		controller.abort({ source: "remove_run", runId, reason, removalReason: options.removalReason });
		aborted = true;
	}

	run.abortController = undefined;
	// Do NOT delete from commandRuns — keep the entry with removed:true so that
	// /sub:history can still display it within the current session.
	// The entry is re-hydrated from JSONL on session reload via subagent-removed entries.
	store.globalLiveRuns.delete(runId);

	if (persistRemovedEntry && options.pi && run.deliveryMode !== "humanOnly") {
		const payload: Record<string, unknown> = { runId };
		if (options.removalReason) payload.reason = options.removalReason;
		try {
			options.pi.appendEntry("subagent-removed", payload);
		} catch {
			/* ignore append failures */
		}
	}

	if (shouldUpdateWidget) {
		updateCommandRunsWidget(store, options.ctx as WidgetRenderCtx | undefined);
	}

	return { removed: true, aborted };
}

/**
 * Trim completed/errored command runs so that the store never exceeds
 * `maxRuns` entries. Oldest finished runs are removed first; running
 * runs are never evicted.
 *
 * Returns the run IDs that were evicted.
 */
export function clearFinishedRuns(store: SubagentStore, options: ClearFinishedRunsOptions = {}): number[] {
	const removedRunIds: number[] = [];

	for (const run of Array.from(store.commandRuns.values())) {
		if (run.removed || run.status === "running") continue;
		const globalEntry = store.globalLiveRuns.get(run.id);
		if (globalEntry?.pendingCompletion) continue;

		const result = removeRun(store, run.id, {
			ctx: options.ctx,
			pi: options.pi,
			abortIfRunning: false,
			updateWidget: false,
			persistRemovedEntry: options.persistRemovedEntry,
			removalReason: options.removalReason,
		});
		if (result.removed) removedRunIds.push(run.id);
	}

	if ((options.updateWidget ?? false) && removedRunIds.length > 0) {
		updateCommandRunsWidget(store, options.ctx as WidgetRenderCtx | undefined);
	}

	return removedRunIds;
}

export function trimCommandRunHistory(
	store: SubagentStore,
	options: number | TrimCommandRunHistoryOptions = 10,
): number[] {
	const maxRuns = typeof options === "number" ? options : (options.maxRuns ?? 10);
	const shouldUpdateWidget = typeof options === "number" ? false : (options.updateWidget ?? false);

	const completed = Array.from(store.commandRuns.values())
		.filter((run) => {
			if (run.removed) return false; // already removed — skip
			if (run.status === "running") return false;
			// Never evict runs with pending cross-session completions.
			const globalEntry = store.globalLiveRuns.get(run.id);
			if (globalEntry?.pendingCompletion) return false;
			return true;
		})
		.sort((a, b) => a.id - b.id);

	// Count only active (non-removed) runs — commandRuns.size includes removed entries.
	let activeCount = Array.from(store.commandRuns.values()).filter((r) => !r.removed).length;

	const removedRunIds: number[] = [];
	while (activeCount > maxRuns && completed.length > 0) {
		const oldest = completed.shift();
		if (!oldest) continue;

		const result = removeRun(store, oldest.id, {
			ctx: typeof options === "number" ? undefined : options.ctx,
			pi: typeof options === "number" ? undefined : options.pi,
			abortIfRunning: false,
			updateWidget: false,
			persistRemovedEntry: true,
			removalReason: typeof options === "number" ? undefined : options.removalReason,
		});
		if (result.removed) {
			removedRunIds.push(oldest.id);
			activeCount--;
		}
	}

	if (shouldUpdateWidget && removedRunIds.length > 0) {
		updateCommandRunsWidget(
			store,
			(typeof options === "number" ? undefined : options.ctx) as WidgetRenderCtx | undefined,
		);
	}

	return removedRunIds;
}

// ── Finished-group retention ────────────────────────────────────────────────
// Batch/chain groups are deleted from the live store once their completion is
// delivered. To keep `subagent status/detail <groupId>` working for a short
// window afterward, we retain an immutable snapshot per finished group.

function memberOutput(run: CommandRunState, fallback?: string): string {
	return run.lastOutput?.trim() || run.lastLine?.trim() || fallback?.trim() || "(no output)";
}

/** Build a finished-group snapshot from a completed batch group. */
export function snapshotBatchGroup(
	store: SubagentStore,
	batch: BatchGroupState,
	terminalStatus: FinishedGroupSnapshot["terminalStatus"],
): FinishedGroupSnapshot {
	let failed = 0;
	const members: FinishedGroupMember[] = batch.runIds.map((runId) => {
		const run = store.commandRuns.get(runId);
		if (!run) {
			if (batch.failedRunIds.has(runId)) failed++;
			return {
				summaryLine: `#${runId} [gone] (run no longer available)`,
				output: batch.pendingResults.get(runId)?.trim() || "(no output)",
			};
		}
		if (run.status === "error" || batch.failedRunIds.has(runId)) failed++;
		return { summaryLine: formatCommandRunSummary(run), output: memberOutput(run, batch.pendingResults.get(runId)) };
	});
	return {
		groupId: batch.batchId,
		kind: "batch",
		terminalStatus,
		finishedAt: Date.now(),
		total: batch.runIds.length,
		failed,
		members,
	};
}

/** Build a finished-group snapshot from a completed pipeline. */
export function snapshotPipeline(
	pipeline: PipelineState,
	terminalStatus: FinishedGroupSnapshot["terminalStatus"],
): FinishedGroupSnapshot {
	const members: FinishedGroupMember[] = pipeline.stepResults.map((step, index) => ({
		summaryLine: `Step ${index + 1} · #${step.runId} ${step.agent} · ${step.status}`,
		output: step.output?.trim() || "(no output)",
		task: step.task,
	}));
	return {
		groupId: pipeline.pipelineId,
		kind: "chain",
		terminalStatus,
		finishedAt: Date.now(),
		total: pipeline.stepResults.length,
		failed: pipeline.stepResults.filter((step) => step.status === "error").length,
		members,
	};
}

/** Retain a finished-group snapshot, evicting the oldest entries past the cap. */
export function retireFinishedGroup(store: SubagentStore, snapshot: FinishedGroupSnapshot): void {
	// Re-insert to refresh insertion order (most-recent last).
	store.finishedGroups.delete(snapshot.groupId);
	store.finishedGroups.set(snapshot.groupId, snapshot);
	while (store.finishedGroups.size > MAX_FINISHED_GROUPS) {
		const oldest = store.finishedGroups.keys().next().value;
		if (oldest === undefined) break;
		store.finishedGroups.delete(oldest);
	}
}

/** Evict finished-group snapshots older than the retention TTL. Returns count removed. */
export function evictStaleFinishedGroups(store: SubagentStore, now = Date.now()): number {
	let removed = 0;
	for (const [groupId, snapshot] of store.finishedGroups) {
		if (now - snapshot.finishedAt > FINISHED_GROUP_TTL_MS) {
			store.finishedGroups.delete(groupId);
			removed++;
		}
	}
	return removed;
}

function formatFinishedAge(finishedAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - finishedAt) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	return `${minutes}m ago`;
}

/** Render a retained finished-group snapshot for `status` (summary) or `detail` (with output). */
export function formatFinishedGroupStatus(snapshot: FinishedGroupSnapshot, detailed: boolean): string {
	const label = snapshot.kind === "batch" ? "subagent-batch" : "subagent-chain";
	const failedSuffix = snapshot.failed > 0 ? `, ${snapshot.failed} failed` : "";
	const header = `[${label}#${snapshot.groupId}] ${snapshot.terminalStatus} · ${snapshot.total} ${
		snapshot.kind === "batch" ? "runs" : "steps"
	}${failedSuffix} · finished ${formatFinishedAge(snapshot.finishedAt)}`;
	const body = snapshot.members
		.map((member) => {
			if (!detailed) return member.summaryLine;
			const output =
				member.output.length > STATUS_OUTPUT_PREVIEW_MAX_CHARS
					? `${member.output.slice(0, STATUS_OUTPUT_PREVIEW_MAX_CHARS)}\n\n... [truncated]`
					: member.output;
			const taskLine = member.task ? `Task: ${member.task}\n` : "";
			return `${member.summaryLine}\n${taskLine}${output}`;
		})
		.join(detailed ? "\n\n" : "\n");
	return `${header}\n\n${body}`;
}
