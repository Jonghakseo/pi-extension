/**
 * Shared utilities for formatting and managing subagent command runs.
 *
 * Extracted from commands.ts to eliminate duplicated run-summary and
 * run-history-trimming logic. Output format is intentionally kept
 * identical to the original inline implementations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentStore } from "./store.js";
import type { CommandRunState } from "./types.js";
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
