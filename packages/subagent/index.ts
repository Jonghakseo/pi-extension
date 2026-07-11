/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports a single run mode via the CLI-style `subagent` command.
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Architecture:
 *   types.ts    — Type definitions, interfaces, Typebox schemas
 *   store.ts    — Shared state (SubagentStore) and state-mutation helpers
 *   format.ts   — Token/usage/tool-call formatting utilities
 *   session.ts  — Session file management and context helpers
 *   runner.ts   — Subagent process execution, agent matching, concurrency
 *   replay.ts   — Session replay viewer (TUI overlay)
 *   widget.ts   — Run status widget (above-editor display)
 *   commands.ts — Tool handler, slash-commands, event handlers
 *   index.ts    — Orchestrator (this file)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupPixelTimer } from "./above-widget.js";
import { registerAll } from "./commands.js";
import { HANG_CHECK_INTERVAL_MS, HANG_TIMEOUT_MS } from "./constants.js";
import { registerAskMasterTool } from "./escalation.js";
import { getSessionFileMtimeMs, readPersistedSessionSnapshot } from "./persisted-session.js";
import { getLastNonEmptyLine } from "./runner.js";
import { createStore, type SubagentStore } from "./store.js";
import type { CommandRunState } from "./types.js";
import { cleanupCommandRunsWidgetTimer, updateCommandRunsWidget } from "./widget.js";

function reconcileRunWithPersistedSession(run: CommandRunState): void {
	if (!run.sessionFile) return;

	const mtimeMs = getSessionFileMtimeMs(run.sessionFile);
	if (mtimeMs && mtimeMs > run.lastActivityAt) {
		run.lastActivityAt = mtimeMs;
	}

	const snapshot = readPersistedSessionSnapshot(run.sessionFile, {
		startOffset: run.persistedSessionBaseOffset,
	});
	if (snapshot.latestActivityAt && snapshot.latestActivityAt > run.lastActivityAt) {
		run.lastActivityAt = snapshot.latestActivityAt;
	}
	if (!snapshot.isTerminal) return;

	const exitCode =
		snapshot.completionMarker?.exitCode ??
		(snapshot.terminalStopReason === "error" || snapshot.terminalStopReason === "aborted" ? 1 : 0);
	run.status = exitCode === 0 ? "done" : "error";
	if (snapshot.finalOutput) {
		run.lastOutput = snapshot.finalOutput;
		run.lastLine = getLastNonEmptyLine(snapshot.finalOutput) || run.lastLine;
	}
	if (snapshot.latestActivityAt) {
		run.elapsedMs = Math.max(run.elapsedMs, snapshot.latestActivityAt - run.startedAt);
	}
}

/**
 * Abort all session-scoped child processes before Pi invalidates this
 * extension runtime. A non-triggering failure entry is persisted so returning
 * to the old session explains why the run stopped.
 */
type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export function shutdownSubagentRuns(store: SubagentStore, pi: ExtensionAPI, reason: SessionShutdownReason): void {
	if (store.disposed) return;
	store.disposed = true;

	const activeRuns = new Map<number, CommandRunState>();
	for (const [runId, run] of store.commandRuns) activeRuns.set(runId, run);
	for (const [runId, entry] of store.globalLiveRuns) activeRuns.set(runId, entry.runState);

	for (const [runId, run] of activeRuns) {
		if (run.status !== "running") continue;
		const message = `Aborted because the parent pi session ${reason} is shutting down.`;
		run.status = "error";
		run.elapsedMs = Date.now() - run.startedAt;
		run.lastActivityAt = Date.now();
		run.lastLine = message;
		run.lastOutput = message;
		run.removed = true;

		const controller = run.abortController ?? store.globalLiveRuns.get(runId)?.abortController;
		controller?.abort();
		run.abortController = undefined;

		if (run.deliveryMode === "humanOnly") continue;
		try {
			pi.sendMessage(
				{
					customType: run.source === "tool" ? "subagent-tool" : "subagent-command",
					content: `[subagent:${run.agent}#${runId}] failed\n\n${message}`,
					display: false,
					details: {
						runId,
						agent: run.agent,
						task: run.task,
						displayTask: run.displayTask,
						status: "error",
						error: message,
						startedAt: run.startedAt,
						elapsedMs: run.elapsedMs,
						lastActivityAt: run.lastActivityAt,
						sessionFile: run.sessionFile,
					},
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
		} catch {
			// The runtime may already be closing; aborting the child remains the priority.
		}
	}

	store.globalLiveRuns.clear();
	store.batchGroups.clear();
	store.pipelines.clear();
	store.recentLaunchTimestamps.clear();
	store.commandRuns.clear();
	store.commandWidgetCtx = null;
	store.pixelWidgetCtx = null;
	cleanupCommandRunsWidgetTimer();
}

/**
 * Sweep active runs for inactivity. The normal run finalizer owns completion
 * delivery so an auto-abort cannot emit two follow-up messages.
 */
export function checkForHungRuns(store: SubagentStore, _pi: ExtensionAPI): void {
	if (store.disposed) return;
	const now = Date.now();
	const processed = new Set<number>();

	function tryAbort(runId: number, run: CommandRunState): void {
		reconcileRunWithPersistedSession(run);
		// Skip if already completed/aborted or not running
		if (run.status !== "running") return;
		if (!run.lastActivityAt) return;
		// Guard: skip runs already auto-aborted (prevents duplicate abort/followUp)
		if (run.lastLine?.startsWith("Auto-aborted:")) return;

		const idleMs = now - run.lastActivityAt;
		if (idleMs < HANG_TIMEOUT_MS) return;

		// Try to abort via run's own controller, then globalLiveRuns fallback
		const globalEntry = store.globalLiveRuns.get(runId);
		const controller = run.abortController ?? globalEntry?.abortController;

		const reason = `Auto-aborted: no activity for ${Math.round(idleMs / 1000)}s`;
		run.lastLine = reason;
		run.lastOutput = reason;
		run.status = "error";
		run.autoAbortReason = reason;

		if (controller) {
			controller.abort();
		}
	}

	// Sweep commandRuns first
	for (const [runId, run] of store.commandRuns) {
		processed.add(runId);
		tryAbort(runId, run);
	}

	// Sweep registry-only runs that are not present in the current widget view.
	for (const [runId, entry] of store.globalLiveRuns) {
		if (processed.has(runId)) continue;
		tryAbort(runId, entry.runState);
	}

	updateCommandRunsWidget(store);
}

export default function (pi: ExtensionAPI) {
	const store = createStore();
	registerAskMasterTool(pi);
	registerAll(pi, store);

	let hangCheckTimer: ReturnType<typeof setInterval> | undefined;
	pi.on("session_start", () => {
		store.disposed = false;
		if (!hangCheckTimer) {
			hangCheckTimer = setInterval(() => checkForHungRuns(store, pi), HANG_CHECK_INTERVAL_MS);
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (hangCheckTimer) {
			clearInterval(hangCheckTimer);
			hangCheckTimer = undefined;
		}
		shutdownSubagentRuns(store, pi, event.reason);
		cleanupPixelTimer();
	});
}
