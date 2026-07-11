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
import { updateCommandRunsWidget } from "./widget.js";

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
 * Sweep all running subagent runs for hang detection.
 * If a run has had no activity for HANG_TIMEOUT_MS, auto-abort it
 * and notify the main session via a followUp message.
 */
export function checkForHungRuns(store: SubagentStore, pi: ExtensionAPI): void {
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

		if (controller) {
			controller.abort();
		}

		const message = `⚠️ worker#${runId} (${run.agent}) — automatically aborted after ${Math.round(idleMs / 1000)}s without activity`;
		if (run.deliveryMode === "humanOnly") {
			return;
		}

		// Notify main session
		pi.sendMessage(
			{
				customType: "subagent-command",
				content: message,
				display: true,
				details: {
					runId,
					agent: run.agent,
					task: run.task,
					displayTask: run.displayTask,
					status: "auto-aborted",
					idleMs,
				},
			},
			{ deliverAs: "followUp", triggerTurn: false },
		);
	}

	// Sweep commandRuns first
	for (const [runId, run] of store.commandRuns) {
		processed.add(runId);
		tryAbort(runId, run);
	}

	// Sweep globalLiveRuns for runs that may have been dropped from commandRuns (e.g. session switch)
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

	// Periodic hang detection — auto-abort subagents with no activity
	const hangCheckTimer = setInterval(() => checkForHungRuns(store, pi), HANG_CHECK_INTERVAL_MS);

	// Clean up intervals on session shutdown
	pi.on("session_shutdown", async () => {
		clearInterval(hangCheckTimer);
		cleanupPixelTimer();
	});
}
