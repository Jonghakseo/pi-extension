/** biome-ignore-all lint/suspicious/noExplicitAny: integrates with dynamic session entries, TUI callbacks, and unexported pi runtime shapes. */
/**
 * Tool handler, slash-command handlers, and event handlers for the Subagent extension.
 *
 * All handlers receive the shared SubagentStore and ExtensionAPI as parameters
 * instead of capturing closure variables — making dependencies explicit.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { discoverAgents } from "./agents.js";
import { loadSubagentConfig } from "./config.js";
import {
	COMMAND_COMPLETION_LIMIT,
	COMMAND_TASK_PREVIEW_CHARS,
	CONTINUATION_OUTPUT_CONTEXT_MAX_CHARS,
	DEFAULT_TURN_COUNT,
	formatSymbolHints,
	MS_PER_SECOND,
	PARENT_ENTRY_TYPE,
	RUN_OUTPUT_MESSAGE_MAX_CHARS,
	RUN_TICK_INTERVAL_MS,
	STALE_PENDING_COMPLETION_MS,
	STATUS_LOG_FOOTER,
	SUBVIEW_OVERLAY_MAX_HEIGHT,
	SUBVIEW_OVERLAY_WIDTH,
} from "./constants.js";
import {
	buildSubagentDisplayTaskFallback,
	createDisplayTaskRefreshToken,
	isDisplayTaskRefreshTokenCurrent,
	shouldSummarizeSubagentTask,
	summarizeSubagentDisplayTask,
} from "./display-task.js";
import { AGENT_NAME_PALETTE, agentBgIndex, formatUsageStats, truncateLines, truncatePlainToWidth } from "./format.js";
import {
	clearPendingGroupCompletion,
	consumePendingGroupCompletionsForSession,
	evictStalePendingGroupCompletions,
	upsertPendingGroupCompletion,
} from "./group-pending.js";
import { enqueueSubagentInvocation } from "./invocation-queue.js";
import { appendDisplayTaskUpdate, getSessionFileSize } from "./persisted-session.js";
import { readSessionReplayItems, SubagentSessionReplayOverlay } from "./replay.js";
import { invokeWithAutoRetry, MAX_SUBAGENT_AUTO_RETRIES } from "./retry.js";
import { getLatestRun, removeRun, trimCommandRunHistory } from "./run-utils.js";
import {
	getFinalOutput,
	getLastNonEmptyLine,
	getSubCommandAgentCompletions,
	matchSubCommandAgent,
	runSingleAgent,
} from "./runner.js";
import { buildMainContextText, makeSubagentSessionFile, wrapTaskWithMainContext } from "./session.js";
import { type SubagentStore, truncateText, updateRunFromResult } from "./store.js";
import { createSubagentToolExecute } from "./tool-execute.js";
import { renderSubagentToolCall, renderSubagentToolResult } from "./tool-render.js";
import type { CommandRunState, SingleResult, SubagentDetails } from "./types.js";
import { ListAgentsParams, SubagentParams } from "./types.js";
import { updateCommandRunsWidget, type WidgetRenderCtx } from "./widget.js";

/**
 * Capture switchSession from an ExtensionCommandContext into the shared store.
 * Command handlers receive ExtensionCommandContext (which has switchSession),
 * while input/event handlers only get ExtensionContext (no switchSession).
 * This allows input handlers (<>, ><) to use the captured function as fallback.
 */
function captureSwitchSession(store: SubagentStore, ctx: any): void {
	if (typeof ctx?.switchSession === "function" && !store.switchSessionFn) {
		store.switchSessionFn = ctx.switchSession.bind(ctx);
	}
}

function refreshDisplayTaskInBackground(
	store: SubagentStore,
	runState: CommandRunState,
	rawTask: string,
	ctx: any,
): void {
	if (!shouldSummarizeSubagentTask(rawTask, runState.displayTask ?? "")) return;
	if (!ctx?.model || typeof ctx?.modelRegistry?.getApiKeyAndHeaders !== "function") return;

	const refreshToken = createDisplayTaskRefreshToken(runState);
	void summarizeSubagentDisplayTask(rawTask, {
		model: ctx.model,
		modelRegistry: {
			getApiKeyAndHeaders: ctx.modelRegistry.getApiKeyAndHeaders.bind(ctx.modelRegistry),
		},
	})
		.then((displayTask) => {
			if (!displayTask || runState.removed || store.disposed) return;
			if (!isDisplayTaskRefreshTokenCurrent(runState, refreshToken)) return;
			if (displayTask === runState.displayTask) return;
			runState.displayTask = displayTask;
			if (runState.deliveryMode !== "humanOnly") {
				const originSessionFile = store.globalLiveRuns.get(runState.id)?.originSessionFile;
				appendDisplayTaskUpdate(originSessionFile, {
					runId: runState.id,
					task: runState.task,
					displayTask,
					startedAt: runState.startedAt,
				});
			}
			updateCommandRunsWidget(store);
		})
		.catch(() => {
			// Ignore background summary failures.
		});
}

// ─── SubagentHistoryOverlay ───────────────────────────────────────────────────

/**
 * TUI overlay that lists all subagent runs (including removed) and lets the
 * user inspect one.
 *
 * Keys: ↑↓ / j k  navigate · Enter  inspect · q / Esc  close
 */
class SubagentHistoryOverlay {
	private selectedIndex = 0;
	private scrollOffset = 0;

	constructor(
		private runs: CommandRunState[],
		private onSelect: (run: CommandRunState) => void,
		private onDone: () => void,
	) {}

	private getViewport(): number {
		const rows = Math.max(10, (process.stdout as any).rows || 24);
		return Math.max(4, rows - 8);
	}

	private ensureVisible(): void {
		const vp = this.getViewport();
		if (this.selectedIndex < this.scrollOffset) {
			this.scrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.scrollOffset + vp) {
			this.scrollOffset = this.selectedIndex - vp + 1;
		}
	}

	handleInput(data: string, tui: any): void {
		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureVisible();
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(this.runs.length - 1, this.selectedIndex + 1);
			this.ensureVisible();
		} else if (matchesKey(data, Key.enter)) {
			const run = this.runs[this.selectedIndex];
			if (run) this.onSelect(run);
			return; // onSelect will close overlay
		} else if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.onDone();
			return;
		}
		tui.requestRender();
	}

	render(width: number, _height: number, theme: any): string[] {
		const container = new Container();
		const pad = "  ";
		const innerWidth = Math.max(20, width - 6);
		const viewport = this.getViewport();
		const total = this.runs.length;

		this.ensureVisible();

		const formatFooterLine = (helpText: string, rangeText: string) => {
			const rangeWidth = visibleWidth(rangeText);
			const gap = rangeWidth > 0 ? 2 : 0;
			const helpWidth = Math.max(0, innerWidth - rangeWidth - gap);
			const help = truncatePlainToWidth(helpText, helpWidth);
			return `${theme.fg("dim", help)}${" ".repeat(gap)}${theme.fg("accent", rangeText)}`;
		};

		container.addChild(new Spacer(1));
		container.addChild(
			new Text(pad + theme.bold("Subagent Run History") + theme.fg("dim", `  (${total} total)`), 0, 0),
		);
		container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(10, innerWidth))), 0, 0));

		for (let row = 0; row < viewport; row++) {
			const idx = this.scrollOffset + row;
			const run = this.runs[idx];
			if (!run) {
				container.addChild(new Text("", 0, 0));
				continue;
			}

			const isSelected = idx === this.selectedIndex;
			const marker = isSelected ? "▸" : " ";

			// Status color
			let statusColor: "success" | "error" | "warning" | "dim" = "dim";
			if (run.status === "done") statusColor = "success";
			else if (run.status === "error") statusColor = "error";
			else if (run.status === "running") statusColor = "warning";

			const timeLabel = new Date(run.startedAt).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});

			const removedBadge = run.removed ? theme.fg("dim", " [removed]") : "";
			const statusStr = theme.fg(statusColor, `[${run.status}]`);
			const agentStr = theme.fg("accent", run.agent);
			const taskPreview = run.task
				.replace(/\s*\n+\s*/g, " ")
				.replace(/\s{2,}/g, " ")
				.trim()
				.slice(0, COMMAND_TASK_PREVIEW_CHARS);

			const fixed = `${marker} #${run.id} ${statusStr}${removedBadge} ${agentStr}  ${theme.fg("dim", timeLabel)}  `;
			const taskWidth = Math.max(0, innerWidth - visibleWidth(fixed));
			let line = `${fixed}${theme.fg("muted", truncatePlainToWidth(taskPreview, taskWidth))}`;

			line = truncateToWidth(line, innerWidth, "");
			if (run.removed) line = theme.fg("dim", line);
			if (isSelected) line = theme.bg("selectedBg", line);

			container.addChild(new Text(pad + line, 0, 0));
		}

		container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(10, innerWidth))), 0, 0));

		const listStart = total === 0 ? 0 : this.scrollOffset + 1;
		const listEnd = Math.min(total, this.scrollOffset + viewport);
		const range = `${listStart}-${listEnd}/${total}`;
		container.addChild(new Text(pad + formatFooterLine("↑↓/jk navigate · Enter inspect · q/Esc close", range), 0, 0));
		container.addChild(new Spacer(1));

		return container.render(width);
	}
}

class SubagentLastResponseOverlay {
	private scrollOffset = 0;
	private cachedWidth = -1;
	private wrappedLines: string[] = [];

	constructor(
		private title: string,
		private subtitle: string,
		private content: string,
		private onAttach: () => void,
		private onDone: () => void,
	) {}

	private getViewportRows(): number {
		const rows = Math.max(18, (process.stdout as any).rows || 24);
		return Math.max(6, rows - 10);
	}

	private getWrappedLines(width: number): string[] {
		if (this.cachedWidth !== width) {
			this.cachedWidth = width;
			this.wrappedLines = new Text(this.content, 0, 0).render(width);
		}
		return this.wrappedLines;
	}

	handleInput(data: string, tui: any): void {
		if (data === "a" || data === "A") {
			this.onAttach();
			this.onDone();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.onDone();
			return;
		}
		const viewport = this.getViewportRows();
		const maxOffset = Math.max(0, this.wrappedLines.length - viewport);
		if (matchesKey(data, Key.up) || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewport);
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + viewport);
		}
		tui.requestRender();
	}

	render(width: number, _height: number, theme: any): string[] {
		const container = new Container();
		const pad = "  ";
		const boxWidth = Math.max(24, width - 10);
		const contentWidth = Math.max(18, boxWidth - 4);
		const viewport = this.getViewportRows();
		const wrappedLines = this.getWrappedLines(contentWidth);
		const maxOffset = Math.max(0, wrappedLines.length - viewport);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
		const visibleLines = wrappedLines.slice(this.scrollOffset, this.scrollOffset + viewport);
		const range =
			wrappedLines.length > 0
				? `${this.scrollOffset + 1}-${Math.min(wrappedLines.length, this.scrollOffset + viewport)}/${wrappedLines.length}`
				: "0/0";
		const shadow = theme.fg("dim", "░");
		const top = theme.fg("border", `┌${"─".repeat(boxWidth - 2)}┐`);
		const separator = theme.fg("borderMuted", `├${"─".repeat(boxWidth - 2)}┤`);
		const bottom = theme.fg("border", `└${"─".repeat(boxWidth - 2)}┘`);
		const fill = (text: string) => {
			const truncated = truncatePlainToWidth(text, contentWidth, "…");
			return `${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}`;
		};
		const frame = (text: string, style: (value: string) => string = (value) => value) =>
			`${theme.fg("border", "│")} ${style(fill(text))} ${theme.fg("border", "│")}`;

		container.addChild(new Spacer(1));
		container.addChild(new Text(`${pad + top} ${shadow}`, 0, 0));
		container.addChild(new Text(`${pad + frame(this.title, (text) => theme.bold(text))} ${shadow}`, 0, 0));
		container.addChild(new Text(`${pad + frame(this.subtitle, (text) => theme.fg("muted", text))} ${shadow}`, 0, 0));
		container.addChild(new Text(`${pad + separator} ${shadow}`, 0, 0));
		for (const line of visibleLines) {
			container.addChild(new Text(`${pad + frame(line, (text) => theme.fg("toolOutput", text))} ${shadow}`, 0, 0));
		}
		if (visibleLines.length === 0) {
			container.addChild(
				new Text(`${pad + frame("(no response)", (text) => theme.fg("muted", text))} ${shadow}`, 0, 0),
			);
		}
		container.addChild(new Text(`${pad + separator} ${shadow}`, 0, 0));
		container.addChild(
			new Text(
				pad +
					frame(`↑↓/jk scroll · a attach to editor · Enter/Esc/q close  ${range}`, (text) => theme.fg("muted", text)) +
					` ${shadow}`,
				0,
				0,
			),
		);
		container.addChild(new Text(`${pad + bottom} ${shadow}`, 0, 0));
		container.addChild(new Text(`${pad} ${theme.fg("dim", "░".repeat(boxWidth))}`, 0, 0));
		container.addChild(new Spacer(1));

		return container.render(width);
	}
}

function getRunLatestResponse(run: CommandRunState): string {
	const output = (run.lastOutput ?? "").trim();
	if (output) return output;

	if (run.sessionFile && fs.existsSync(run.sessionFile)) {
		const replayItems = readSessionReplayItems(run.sessionFile);
		for (let i = replayItems.length - 1; i >= 0; i--) {
			const item = replayItems[i];
			if (item?.type === "assistant" && item.content.trim()) return item.content.trim();
		}
		for (let i = replayItems.length - 1; i >= 0; i--) {
			const item = replayItems[i];
			if (item && item.type !== "user" && item.content.trim()) return item.content.trim();
		}
	}

	if (run.status === "running") return "(still running; no final response yet)";
	return run.lastLine?.trim() || "(no response captured)";
}

function attachRunResponseToEditor(ctx: ExtensionContext, run: CommandRunState, response: string): void {
	const current = ctx.ui.getEditorText();
	const separator = current.trim().length > 0 ? "\n\n" : "";
	const attachment = `[subagent:${run.agent}#${run.id}]\n${response}`;
	ctx.ui.setEditorText(`${current}${separator}${attachment}`);
	ctx.ui.notify(`Attached subagent #${run.id} response to editor`, "info");
}

async function showRunLatestResponseOverlay(ctx: ExtensionContext, run: CommandRunState): Promise<void> {
	const response = getRunLatestResponse(run);
	const contextLabel = run.contextMode === "main" ? "main" : "sub";
	const subtitle = `#${run.id} · ${run.agent} · ${run.status} · ctx:${contextLabel} · turn:${run.turnCount ?? DEFAULT_TURN_COUNT}`;

	await ctx.ui.custom(
		(tui, theme, _kb, done) => {
			const overlay = new SubagentLastResponseOverlay(
				`Subagent #${run.id} last response`,
				subtitle,
				response,
				() => attachRunResponseToEditor(ctx, run, response),
				() => done(undefined),
			);
			return {
				render: (w) => overlay.render(w, 0, theme),
				handleInput: (data) => overlay.handleInput(data, tui),
				invalidate: () => {},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: SUBVIEW_OVERLAY_WIDTH, maxHeight: SUBVIEW_OVERLAY_MAX_HEIGHT, anchor: "center" },
		},
	);
}

// ─── subPeekHandler ──────────────────────────────────────────────────────────

async function subPeekHandler(args: string, ctx: ExtensionContext, store: SubagentStore): Promise<void> {
	const raw = (args ?? "").trim();
	let run: CommandRunState | undefined;
	let runId: number | undefined;

	if (!raw) {
		run = getLatestRun(store);
		runId = run?.id;
	} else if (/^\d+$/.test(raw)) {
		runId = Number(raw);
		run = store.commandRuns.get(runId);
	} else {
		ctx.ui.notify("Usage: /sub:peek [runId] or <>7", "info");
		return;
	}

	if (!run || runId === undefined) {
		ctx.ui.notify(`Unknown subagent run${raw ? ` #${raw}` : ""}.`, "error");
		return;
	}

	const response = getRunLatestResponse(run);
	if (!ctx.hasUI) {
		ctx.ui.notify(`Subagent #${run.id} last response\n\n${response}`, "info");
		return;
	}

	await showRunLatestResponseOverlay(ctx, run);
}

/**
 * Stage A: normalize a path — trim outer whitespace, strip CR/LF/TAB only.
 * Preserves interior spaces (valid in macOS paths).
 */
function normalizePath(raw: unknown): string | null {
	if (!raw || typeof raw !== "string") return null;
	const cleaned = raw.replace(/[\r\n\t]+/g, "").trim();
	return cleaned || null;
}

function stripStatusLogFooter(text: string): string {
	if (!text) return text;
	const doubleBreakSuffix = `\n\n${STATUS_LOG_FOOTER}`;
	if (text.endsWith(doubleBreakSuffix)) return text.slice(0, -doubleBreakSuffix.length);
	const singleBreakSuffix = `\n${STATUS_LOG_FOOTER}`;
	if (text.endsWith(singleBreakSuffix)) return text.slice(0, -singleBreakSuffix.length);
	if (text.endsWith(STATUS_LOG_FOOTER)) return text.slice(0, -STATUS_LOG_FOOTER.length).trimEnd();
	return text;
}

function toValidTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function toNonNegativeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

/**
 * Clear commandRuns and restore from current session entries.
 * Used by session_start handler (covers all session lifecycle reasons).
 * Also restores `currentParentSessionFile` from the latest `subagent-parent` entry.
 *
 * Includes backward-compatible in-memory and pending-completion recovery for
 * hosts that reuse one extension runtime. Standard Pi session replacement is
 * handled by aborting active children during session_shutdown.
 */
function restoreRunsFromSession(store: SubagentStore, ctx: any, pi?: ExtensionAPI): void {
	let currentSessionFile: string | null = null;
	try {
		currentSessionFile = normalizePath(ctx.sessionManager.getSessionFile());
	} catch {
		currentSessionFile = null;
	}

	// Legacy fallback for hosts that reuse a runtime across session_start events.
	if (store.currentSessionFile && store.currentSessionFile !== currentSessionFile) {
		const snapshot = Array.from(store.commandRuns.values()).map((run) => ({ ...run }));
		if (snapshot.length > 0) {
			store.sessionRunCache.set(store.currentSessionFile, snapshot);
		}
	}
	store.currentSessionFile = currentSessionFile;

	store.commandRuns.clear();
	store.commandWidgetCtx = ctx as unknown as WidgetRenderCtx;
	let sawSubagentMarkers = false;

	try {
		const entries = ctx.sessionManager.getEntries();
		const restoredRuns = new Map<number, CommandRunState>();
		const removedRunIds = new Set<number>();
		const displayTaskUpdates = new Map<number, { task?: string; displayTask?: string; startedAt?: number }>();
		let maxRunId = 0;

		// Restore parent link from latest subagent-parent entry (if any).
		let latestParentSessionFile: string | null = null;
		for (const entry of entries) {
			if (entry.type === "custom") {
				const ce = entry as any;
				if (ce.customType === PARENT_ENTRY_TYPE) {
					sawSubagentMarkers = true;
					if (ce.data?.parentSessionFile) {
						const cleaned = normalizePath(ce.data.parentSessionFile);
						if (cleaned) latestParentSessionFile = cleaned;
					}
				}
			}
		}
		store.currentParentSessionFile = latestParentSessionFile;

		// First pass: collect removed run IDs and persisted displayTask updates
		for (const entry of entries) {
			if (entry.type === "custom") {
				const ce = entry as any;
				if (ce.customType === "subagent-removed") {
					sawSubagentMarkers = true;
					if (ce.data?.runId != null) {
						removedRunIds.add(ce.data.runId);
					}
					continue;
				}
				if (ce.customType === "subagent-display-task" && typeof ce.data?.runId === "number") {
					sawSubagentMarkers = true;
					displayTaskUpdates.set(ce.data.runId, {
						task: typeof ce.data?.task === "string" ? ce.data.task : undefined,
						displayTask: typeof ce.data?.displayTask === "string" ? ce.data.displayTask : undefined,
						startedAt: toValidTimestampMs(ce.data?.startedAt),
					});
				}
			}
		}

		for (const entry of entries) {
			if (entry.type !== "custom_message") continue;
			const cm = entry as any;
			if (cm.customType !== "subagent-command" && cm.customType !== "subagent-tool") continue;
			sawSubagentMarkers = true;
			const d = cm.details;
			if (!d || typeof d.runId !== "number") continue;

			const runId = d.runId;
			if (runId > maxRunId) maxRunId = runId;

			const existing = restoredRuns.get(runId);
			const displayTaskUpdate = displayTaskUpdates.get(runId);
			const entryTimestampMs = toValidTimestampMs((entry as any).timestamp);
			const startedAtFromDetails = toValidTimestampMs(d.startedAt);
			const elapsedFromDetails = toNonNegativeNumber(d.elapsedMs);
			const lastActivityAtFromDetails = toValidTimestampMs(d.lastActivityAt);
			const persistedSessionBaseOffset =
				toNonNegativeNumber(d.persistedSessionBaseOffset) ?? existing?.persistedSessionBaseOffset;

			// Determine final status primarily from structured metadata.
			const content = typeof cm.content === "string" ? cm.content : "";
			const statusRaw = typeof d.status === "string" ? d.status.trim().toLowerCase() : "";
			const statusFromDetails: "done" | "error" | null =
				statusRaw === "done" || statusRaw === "completed"
					? "done"
					: statusRaw === "error" || statusRaw === "failed"
						? "error"
						: null;
			const statusFromExitCode: "done" | "error" | null =
				typeof d.exitCode === "number" ? (d.exitCode === 0 ? "done" : "error") : null;
			const statusFromErrorField: "done" | "error" | null =
				typeof d.error === "string" && d.error.trim() ? "error" : null;

			// Legacy fallback for old sessions where structured fields are missing.
			const legacyStatusFromContent: "done" | "error" | null = content.includes("] completed")
				? "done"
				: content.includes("] failed") || content.includes("] error")
					? "error"
					: null;

			const finalStatus = statusFromDetails ?? statusFromExitCode ?? statusFromErrorField ?? legacyStatusFromContent;

			// Derive source from customType for backward-compatible restored run metadata.
			const restoredSource: "tool" | "command" = cm.customType === "subagent-tool" ? "tool" : "command";

			if (finalStatus) {
				// Final message — create or overwrite with done/error state
				const startedAt = startedAtFromDetails ?? existing?.startedAt ?? entryTimestampMs ?? Date.now();
				const elapsedMs =
					elapsedFromDetails ??
					(existing?.elapsedMs && existing.elapsedMs > 0 ? existing.elapsedMs : undefined) ??
					(entryTimestampMs !== undefined ? Math.max(0, entryTimestampMs - startedAt) : 0);
				const lastActivityAt =
					lastActivityAtFromDetails ?? entryTimestampMs ?? existing?.lastActivityAt ?? startedAt + elapsedMs;

				const persistedDisplayTask =
					displayTaskUpdate?.startedAt === startedAt ? displayTaskUpdate.displayTask : undefined;
				const persistedDisplayTaskFallbackTask =
					displayTaskUpdate?.startedAt === startedAt ? displayTaskUpdate.task : undefined;
				const run: CommandRunState = {
					id: runId,
					agent: d.agent ?? existing?.agent ?? "unknown",
					task: d.task ?? existing?.task ?? "",
					displayTask:
						persistedDisplayTask ??
						d.displayTask ??
						existing?.displayTask ??
						persistedDisplayTaskFallbackTask ??
						d.task ??
						existing?.task ??
						"",
					status: finalStatus,
					startedAt,
					lastActivityAt,
					elapsedMs,
					toolCalls: existing?.toolCalls ?? 0,
					lastLine: "",
					lastOutput: "",
					continuedFromRunId: d.continuedFromRunId,
					turnCount: d.turnCount ?? existing?.turnCount ?? DEFAULT_TURN_COUNT,
					sessionFile: d.sessionFile ?? existing?.sessionFile,
					persistedSessionBaseOffset,
					contextMode: d.contextMode ?? existing?.contextMode,
					usage: d.usage ?? existing?.usage,
					model: d.model ?? existing?.model,
					thoughtText: d.thoughtText ?? d.progressText ?? existing?.thoughtText,
					source: restoredSource,
					runtime: d.runtime ?? existing?.runtime,
					claudeSessionId: d.claudeSessionId ?? existing?.claudeSessionId,
					claudeProjectDir: d.claudeProjectDir ?? existing?.claudeProjectDir,
				};
				// Extract thought/progress and output from content payload
				const lines = content.split("\n");
				if (!run.thoughtText) {
					const thoughtLine = lines.find(
						(l: string) => l.startsWith("Thought: ") || l.startsWith("Result: ") || l.startsWith("Progress: "),
					);
					if (thoughtLine) run.thoughtText = thoughtLine.replace(/^(Thought|Result|Progress): /, "").trim();
				}
				const bodyStart = lines.findIndex((l: string) => l === "") + 1;
				if (bodyStart > 0 && bodyStart < lines.length) {
					run.lastOutput = stripStatusLogFooter(lines.slice(bodyStart).join("\n"));
					run.lastLine = getLastNonEmptyLine(run.lastOutput);
				}
				restoredRuns.set(runId, run);
			} else {
				// Started/resumed message — always update so we track the latest continuation.
				// If a completion message follows, it will overwrite this.
				// If not (crash/abort), this "interrupted" state persists.
				const startedAt = startedAtFromDetails ?? entryTimestampMs ?? existing?.startedAt ?? Date.now();
				const lastActivityAt = lastActivityAtFromDetails ?? entryTimestampMs ?? existing?.lastActivityAt ?? startedAt;

				const persistedDisplayTask =
					displayTaskUpdate?.startedAt === startedAt ? displayTaskUpdate.displayTask : undefined;
				const persistedDisplayTaskFallbackTask =
					displayTaskUpdate?.startedAt === startedAt ? displayTaskUpdate.task : undefined;
				restoredRuns.set(runId, {
					id: runId,
					agent: d.agent ?? existing?.agent ?? "unknown",
					task: d.task ?? existing?.task ?? "",
					displayTask:
						persistedDisplayTask ??
						d.displayTask ??
						existing?.displayTask ??
						persistedDisplayTaskFallbackTask ??
						d.task ??
						existing?.task ??
						"",
					status: "error",
					startedAt,
					lastActivityAt,
					elapsedMs: elapsedFromDetails ?? 0,
					toolCalls: existing?.toolCalls ?? 0,
					lastLine: "(interrupted — started but no completion found)",
					lastOutput: existing?.lastOutput,
					continuedFromRunId: d.continuedFromRunId,
					turnCount: d.turnCount ?? existing?.turnCount ?? DEFAULT_TURN_COUNT,
					sessionFile: d.sessionFile ?? existing?.sessionFile,
					persistedSessionBaseOffset,
					contextMode: d.contextMode ?? existing?.contextMode,
					usage: existing?.usage,
					model: existing?.model,
					thoughtText: d.thoughtText ?? d.progressText ?? existing?.thoughtText,
					source: restoredSource,
					runtime: d.runtime ?? existing?.runtime,
					claudeSessionId: d.claudeSessionId ?? existing?.claudeSessionId,
					claudeProjectDir: d.claudeProjectDir ?? existing?.claudeProjectDir,
				});
			}
		}

		for (const [id, run] of restoredRuns) {
			if (removedRunIds.has(id)) {
				store.commandRuns.set(id, { ...run, removed: true }); // restore removed runs while preserving removed=true
				continue;
			}
			store.commandRuns.set(id, run);
		}
		if (maxRunId >= store.nextCommandRunId) {
			store.nextCommandRunId = maxRunId + 1;
		}
	} catch (_e) {
		// Silently ignore restore errors — fresh state is fine
	}

	// ── Legacy live-run merge (origin session only) ────────────────────
	const mergeSessionFile = currentSessionFile;
	if (mergeSessionFile) {
		for (const [runId, entry] of store.globalLiveRuns) {
			if (entry.originSessionFile !== mergeSessionFile) continue;
			if (!entry.runState.removed) {
				store.commandRuns.set(runId, entry.runState);
			}
		}
	}

	// ── Deliver legacy pending completions ──────────────────────────────
	if (pi && currentSessionFile) {
		for (const [runId, entry] of store.globalLiveRuns) {
			if (!entry.pendingCompletion) continue;
			if (entry.originSessionFile === currentSessionFile) {
				try {
					pi.sendMessage(entry.pendingCompletion.message, entry.pendingCompletion.options);
					store.commandRuns.set(runId, entry.runState);
					store.globalLiveRuns.delete(runId);
				} catch {
					/* keep pending completion for later retry */
				}
			}
		}

		for (const [batchId, batch] of store.batchGroups) {
			if (!batch.pendingCompletion) continue;
			if (batch.originSessionFile !== currentSessionFile) continue;
			try {
				pi.sendMessage(batch.pendingCompletion.message, batch.pendingCompletion.options);
				clearPendingGroupCompletion("batch", batchId);
				for (const runId of batch.runIds) {
					store.globalLiveRuns.delete(runId);
				}
				store.batchGroups.delete(batchId);
			} catch {
				upsertPendingGroupCompletion({
					scope: "batch",
					groupId: batchId,
					originSessionFile: batch.originSessionFile,
					runIds: batch.runIds,
					pendingCompletion: batch.pendingCompletion,
				});
			}
		}

		for (const [pipelineId, pipeline] of store.pipelines) {
			if (!pipeline.pendingCompletion) continue;
			if (pipeline.originSessionFile !== currentSessionFile) continue;
			try {
				pi.sendMessage(pipeline.pendingCompletion.message, pipeline.pendingCompletion.options);
				clearPendingGroupCompletion("chain", pipelineId);
				for (const runId of pipeline.stepRunIds) {
					store.globalLiveRuns.delete(runId);
				}
				store.pipelines.delete(pipelineId);
			} catch {
				upsertPendingGroupCompletion({
					scope: "chain",
					groupId: pipelineId,
					originSessionFile: pipeline.originSessionFile,
					runIds: pipeline.stepRunIds,
					pendingCompletion: pipeline.pendingCompletion,
				});
			}
		}

		for (const pending of consumePendingGroupCompletionsForSession(currentSessionFile)) {
			try {
				pi.sendMessage(pending.pendingCompletion.message, pending.pendingCompletion.options);
			} catch {
				upsertPendingGroupCompletion(pending);
			}
		}
	}

	// ── Evict stale pending completions (memory leak guard) ─────────────
	// If a completed run's pending completion has been sitting for longer
	// than the threshold without the user returning to its origin session,
	// discard it to prevent unbounded memory growth.
	for (const [runId, entry] of store.globalLiveRuns) {
		if (!entry.pendingCompletion) continue;
		if (entry.runState.status === "running") continue;
		const pendingSince = entry.pendingCompletion.createdAt ?? entry.runState.startedAt + entry.runState.elapsedMs;
		if (Date.now() - pendingSince > STALE_PENDING_COMPLETION_MS) {
			store.globalLiveRuns.delete(runId);
		}
	}

	for (const [batchId, batch] of store.batchGroups) {
		if (!batch.pendingCompletion) continue;
		const pendingSince = batch.pendingCompletion.createdAt ?? batch.createdAt;
		if (Date.now() - pendingSince > STALE_PENDING_COMPLETION_MS) {
			clearPendingGroupCompletion("batch", batchId);
			store.batchGroups.delete(batchId);
		}
	}

	for (const [pipelineId, pipeline] of store.pipelines) {
		if (!pipeline.pendingCompletion) continue;
		const pendingSince = pipeline.pendingCompletion.createdAt ?? pipeline.createdAt;
		if (Date.now() - pendingSince > STALE_PENDING_COMPLETION_MS) {
			clearPendingGroupCompletion("chain", pipelineId);
			store.pipelines.delete(pipelineId);
		}
	}

	evictStalePendingGroupCompletions(STALE_PENDING_COMPLETION_MS);

	// Fallback: if this session has no subagent markers at all, but we recently
	// had in-memory runs for the same session file, reuse that snapshot so
	// <> / >< hops do not make runs appear to "disappear".
	if (store.commandRuns.size === 0 && !sawSubagentMarkers && currentSessionFile) {
		const cached = store.sessionRunCache.get(currentSessionFile) ?? [];
		for (const run of cached) {
			store.commandRuns.set(run.id, { ...run });
		}
	}

	// Refresh per-session snapshot with the latest reconstructed view.
	if (currentSessionFile) {
		const latestSnapshot = Array.from(store.commandRuns.values()).map((run) => ({ ...run }));
		if (latestSnapshot.length > 0) {
			store.sessionRunCache.set(currentSessionFile, latestSnapshot);
		} else {
			store.sessionRunCache.delete(currentSessionFile);
		}
	}

	updateCommandRunsWidget(store, ctx as unknown as WidgetRenderCtx);
}

function deliverOrQueueCompletion(
	store: SubagentStore,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runId: number,
	runState: CommandRunState,
	message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
): void {
	const options = { deliverAs: "followUp" as const };
	const globalEntry = store.globalLiveRuns.get(runId);
	let currentSessionFile: string | null = null;
	try {
		currentSessionFile = normalizePath(ctx.sessionManager.getSessionFile());
	} catch {
		/* ignore */
	}

	const inOriginSession =
		!globalEntry ||
		!currentSessionFile ||
		!globalEntry.originSessionFile ||
		currentSessionFile === globalEntry.originSessionFile;

	if (inOriginSession) {
		pi.sendMessage(message, options);
		store.globalLiveRuns.delete(runId);
	} else {
		globalEntry.pendingCompletion = {
			message,
			options,
			createdAt: Date.now(),
		};
		store.commandRuns.set(runId, runState);
	}
}

function finalizeHumanOnlyCompletion(
	store: SubagentStore,
	ctx: ExtensionContext,
	runId: number,
	_title: string,
	_content: string,
	notifyMessage: string,
	notifyLevel: "info" | "error" | "warning",
): void {
	ctx.ui.notify(notifyMessage, notifyLevel);
	store.globalLiveRuns.delete(runId);
}

export function registerAll(pi: ExtensionAPI, store: SubagentStore): void {
	pi.registerTool({
		name: "list-agents",
		label: "List Agents",
		description:
			"List available subagent definitions (name, source, model, thinking, tools, description). Useful before planning delegation.",
		parameters: ListAgentsParams,
		execute: async (_toolCallId, _params: Record<string, any>, _signal, _onUpdate, ctx) => {
			const discovery = discoverAgents(ctx.cwd);
			const agents = discovery.agents;

			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "No subagents found." }],
					details: {
						projectAgentsDir: discovery.projectAgentsDir,
						agents: [],
					},
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
				details: {
					projectAgentsDir: discovery.projectAgentsDir,
					agents: agents.map((agent) => ({
						name: agent.name,
						source: agent.source,
						model: agent.model,
						thinking: agent.thinking,
						tools: agent.tools ?? [],
						description: agent.description,
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"CLI-style subagent delegation. Use `subagent help` for commands. Async launches return later in TUI mode; do not poll immediately after launch.",
		parameters: SubagentParams,

		execute: createSubagentToolExecute(pi, store) as any,

		renderCall: renderSubagentToolCall as any,

		renderResult: renderSubagentToolResult as any,
	});

	const subCommand = {
		description:
			"Run a subagent in a dedicated sub-session: /sub:isolate <agent|alias> <task>, /sub:isolate <runId> <task>, /sub:isolate <task> (uses configured defaultAgent)",
		getArgumentCompletions: (argumentPrefix: string) => {
			const trimmedStart = argumentPrefix.trimStart();
			if (trimmedStart.includes(" ")) return null;

			const discovery = discoverAgents(process.cwd());
			const agentItems = getSubCommandAgentCompletions(discovery.agents, argumentPrefix) ?? [];

			const runItems = Array.from(store.commandRuns.values())
				.sort((a, b) => b.id - a.id)
				.filter((run) => !trimmedStart || run.id.toString().startsWith(trimmedStart))
				.slice(0, COMMAND_COMPLETION_LIMIT)
				.map((run) => ({
					value: `${run.id} `,
					label: `${run.id}`,
					description: `continue ${run.agent}: ${truncateText(run.task, COMMAND_TASK_PREVIEW_CHARS)}`,
				}));

			const merged = [...runItems, ...agentItems];
			return merged.length > 0 ? merged : null;
		},
		handler: async (
			args: string,
			ctx: ExtensionContext,
			forceMainContextFromWrapper = false,
			hiddenFromMain = false,
		) => {
			captureSwitchSession(store, ctx);
			const input = (args ?? "").trim();
			const usageText =
				"Usage: /sub:main <agent|alias> <task> | /sub:main <runId> <task> | /sub:main <task> | /sub:isolate <agent|alias> <task> | /sub:isolate <runId> <task> | /sub:isolate <task>";
			let forceMainContext = forceMainContextFromWrapper;
			const deliveryMode = hiddenFromMain ? "humanOnly" : "followUp";

			if (input === "--main" || input.startsWith("--main ")) {
				ctx.ui.notify(
					"The '--main' prefix is not supported. Choose the context with /sub:main or /sub:isolate.",
					"warning",
				);
				return;
			}

			if (!input) {
				ctx.ui.notify(usageText, "info");
				return;
			}

			if (hiddenFromMain && !ctx.hasUI) {
				pi.sendMessage(
					{
						customType: "subagent-command",
						content: "Hidden subagent mode requires interactive UI. Use /sub:isolate instead.",
						display: true,
						details: {},
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
				return;
			}

			const discovery = discoverAgents(ctx.cwd);
			const agents = discovery.agents;

			if (agents.length === 0) {
				ctx.ui.notify(
					"No subagents found. Checked the configured agent directory plus project-local .pi/agents and .claude/agents.",
					"error",
				);
				return;
			}

			const firstSpace = input.indexOf(" ");
			const firstToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
			const continuationRun = /^\d+$/.test(firstToken) ? store.commandRuns.get(Number(firstToken)) : undefined;

			let selectedAgent: string;
			let taskForDisplay: string;
			let taskForAgent: string;
			let continuedFromRunId: number | undefined;
			let sessionFileForRun: string | undefined;

			if (continuationRun) {
				if (firstSpace === -1) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				const targetRunId = Number(firstToken);
				const targetRun = continuationRun;

				if (targetRun.status === "running") {
					ctx.ui.notify(`Subagent #${targetRunId} is already running.`, "warning");
					return;
				}

				if (targetRun.runtime === "claude") {
					if (!targetRun.claudeSessionId) {
						ctx.ui.notify(
							`Cannot resume Claude run #${targetRunId}: no claudeSessionId found. The session metadata was lost or never captured.`,
							"error",
						);
						return;
					}
					if (!targetRun.claudeProjectDir || targetRun.claudeProjectDir !== ctx.cwd) {
						ctx.ui.notify(
							`Cannot resume Claude run #${targetRunId}: claudeProjectDir mismatch. Expected "${targetRun.claudeProjectDir ?? "(none)"}", current cwd is "${ctx.cwd}".`,
							"error",
						);
						return;
					}
				}

				const nextInstruction = input.slice(firstSpace + 1).trim();
				if (!nextInstruction) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				const previousAgentName = targetRun.agent;
				const directAgent = agents.find((agent) => agent.name.toLowerCase() === previousAgentName.toLowerCase());
				const fuzzyAgent = matchSubCommandAgent(agents, previousAgentName).matchedAgent;
				selectedAgent = directAgent?.name ?? fuzzyAgent?.name ?? previousAgentName;

				if (!agents.some((agent) => agent.name === selectedAgent)) {
					ctx.ui.notify(
						`Run #${targetRunId} references unknown agent "${previousAgentName}". Use /sub:main <agent> <task> instead.`,
						"error",
					);
					return;
				}

				taskForDisplay = `[continue #${targetRunId}] ${nextInstruction}`;
				continuedFromRunId = targetRunId;
				sessionFileForRun = targetRun.sessionFile;

				if (sessionFileForRun) {
					// True continuation: reuse the same per-run session file.
					taskForAgent = nextInstruction;
				} else {
					// Fallback for older runs that were started in isolated/no-session mode.
					const previousOutputRaw = (targetRun.lastOutput ?? targetRun.lastLine ?? "").trim();
					const previousOutput =
						previousOutputRaw.length > CONTINUATION_OUTPUT_CONTEXT_MAX_CHARS
							? `${previousOutputRaw.slice(0, CONTINUATION_OUTPUT_CONTEXT_MAX_CHARS)}\n... [truncated]`
							: previousOutputRaw;

					taskForAgent = [
						`Continue subagent run #${targetRunId} using the same agent (${selectedAgent}).`,
						`Previous task:\n${targetRun.task}`,
						previousOutput ? `Previous output:\n${previousOutput}` : "Previous output: (not available)",
						`New instruction:\n${nextInstruction}`,
					].join("\n\n");
				}
			} else {
				const { matchedAgent, ambiguousAgents } = matchSubCommandAgent(agents, firstToken);
				let resolvedAgent = matchedAgent;

				if (ambiguousAgents.length > 1) {
					const names = ambiguousAgents.map((agent) => agent.name).join(", ");

					if (firstSpace === -1) {
						ctx.ui.notify(`${usageText}. Ambiguous agent alias "${firstToken}": ${names}.`, "error");
						return;
					}

					// NOTE(user-approved): preserve the existing notification behavior in no-UI mode.
					// (Improving the headless/RPC warning path is outside this change.)
					if (!ctx.hasUI) {
						ctx.ui.notify(
							`Ambiguous agent alias "${firstToken}": ${names}. Use a longer alias or exact name.`,
							"error",
						);
						return;
					}

					const selectedName = await ctx.ui.select(
						`Ambiguous alias "${firstToken}" — choose subagent`,
						ambiguousAgents.map((agent) => agent.name),
					);
					if (!selectedName) {
						ctx.ui.notify("Subagent selection cancelled.", "info");
						return;
					}

					resolvedAgent = ambiguousAgents.find((agent) => agent.name === selectedName);
					if (!resolvedAgent) {
						ctx.ui.notify("Could not resolve selected subagent.", "error");
						return;
					}
				}

				if (resolvedAgent && firstSpace === -1) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				const defaultAgent = loadSubagentConfig(ctx.cwd).defaultAgent;
				selectedAgent = resolvedAgent?.name ?? defaultAgent;
				if (!resolvedAgent && !agents.some((agent) => agent.name === defaultAgent)) {
					const availableAgents = agents
						.map((agent) => agent.name)
						.sort()
						.join(", ");
					ctx.ui.notify(
						`Configured defaultAgent "${defaultAgent}" was not found. Available agents: ${availableAgents}. Set subagent.defaultAgent in the global settings or defaultAgent in .pi/subagent.json.`,
						"error",
					);
					return;
				}
				taskForDisplay = resolvedAgent ? input.slice(firstSpace + 1).trim() : input;

				if (!taskForDisplay) {
					ctx.ui.notify(usageText, "info");
					return;
				}

				taskForAgent = taskForDisplay;
			}

			let runId: number;
			let runState: CommandRunState;

			if (continuedFromRunId !== undefined) {
				const existingRun = store.commandRuns.get(continuedFromRunId);
				if (!existingRun) {
					ctx.ui.notify(`Unknown subagent run #${continuedFromRunId}.`, "error");
					return;
				}

				runId = existingRun.id;
				runState = existingRun;
				runState.agent = selectedAgent;
				runState.task = taskForDisplay;
				runState.displayTask = buildSubagentDisplayTaskFallback(taskForDisplay);
				runState.status = "running";
				runState.startedAt = Date.now();
				runState.lastActivityAt = Date.now();
				runState.elapsedMs = 0;
				runState.toolCalls = 0;
				runState.lastLine = "";
				runState.lastOutput = "";
				runState.continuedFromRunId = continuedFromRunId;
				runState.usage = undefined;
				runState.model = undefined;
				runState.retryCount = 0;
				runState.lastRetryReason = undefined;
				runState.removed = false;
				runState.deliveryMode = deliveryMode;
				runState.turnCount = Math.max(DEFAULT_TURN_COUNT, runState.turnCount || DEFAULT_TURN_COUNT) + 1;
				// NOTE(user-approved): continuations preserve the existing context and session.
				// Switching between /sub:main and /sub:isolate does not retroactively affect existing runs.
				runState.contextMode = runState.contextMode ?? (forceMainContext ? "main" : "sub");
				runState.sessionFile = runState.sessionFile ?? sessionFileForRun ?? makeSubagentSessionFile(runId);
				runState.persistedSessionBaseOffset = getSessionFileSize(runState.sessionFile);
				sessionFileForRun = runState.sessionFile;
			} else {
				runId = store.nextCommandRunId++;
				if (forceMainContext) {
					// Extract main session context as text instead of copying the session file.
					// This prevents subagents from inheriting the main agent's persona.
					const subContextResult = buildMainContextText(ctx);
					const subContextText = typeof subContextResult === "string" ? subContextResult : subContextResult.text;
					const totalMessageCount = typeof subContextResult === "string" ? 0 : subContextResult.totalMessageCount;
					const rawMainSessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;
					const mainSessionFile =
						typeof rawMainSessionFile === "string"
							? rawMainSessionFile.replace(/[\r\n\t]+/g, "").trim() || undefined
							: undefined;
					if (subContextText || mainSessionFile) {
						taskForAgent = wrapTaskWithMainContext(taskForAgent, subContextText, {
							mainSessionFile,
							totalMessageCount,
						});
					} else {
						ctx.ui.notify(
							"Main session context is unavailable in this mode. Running with dedicated sub-session.",
							"warning",
						);
						forceMainContext = false;
					}
					sessionFileForRun = makeSubagentSessionFile(runId);
				} else {
					sessionFileForRun = makeSubagentSessionFile(runId);
				}

				runState = {
					id: runId,
					agent: selectedAgent,
					task: taskForDisplay,
					displayTask: buildSubagentDisplayTaskFallback(taskForDisplay),
					status: "running",
					startedAt: Date.now(),
					lastActivityAt: Date.now(),
					elapsedMs: 0,
					toolCalls: 0,
					lastLine: "",
					lastOutput: "",
					continuedFromRunId,
					turnCount: DEFAULT_TURN_COUNT,
					sessionFile: sessionFileForRun,
					persistedSessionBaseOffset: getSessionFileSize(sessionFileForRun),
					removed: false,
					contextMode: forceMainContext ? "main" : "sub",
					retryCount: 0,
					deliveryMode,
				};
				store.commandRuns.set(runId, runState);
			}

			const abortController = new AbortController();
			runState.abortController = abortController;

			// Register for abort and completion handling within this session runtime.
			let originSessionFile = "";
			try {
				originSessionFile = normalizePath(ctx.sessionManager.getSessionFile()) ?? "";
			} catch {
				/* ignore */
			}
			store.globalLiveRuns.set(runId, {
				runState,
				abortController,
				originSessionFile,
			});

			store.commandWidgetCtx = ctx as unknown as WidgetRenderCtx;
			updateCommandRunsWidget(store, ctx as unknown as WidgetRenderCtx);
			refreshDisplayTaskInBackground(store, runState, taskForDisplay, ctx);

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode: "single",
				inheritMainContext: runState.contextMode === "main",
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			const contextLabel = hiddenFromMain
				? "hidden sub-session"
				: runState.contextMode === "main"
					? "main context"
					: "dedicated sub-session";
			const startedState = continuedFromRunId !== undefined ? "resumed" : "started";

			if (!hiddenFromMain) {
				pi.sendMessage(
					{
						customType: "subagent-command",
						content:
							`[subagent:${selectedAgent}#${runId}] ${startedState}` +
							`\nContext: ${contextLabel} · turn ${runState.turnCount}` +
							``,
						display: false,
						details: {
							runId,
							agent: selectedAgent,
							task: taskForDisplay,
							displayTask: runState.displayTask,
							continuedFromRunId,
							turnCount: runState.turnCount,
							contextMode: runState.contextMode,
							sessionFile: runState.sessionFile,
							persistedSessionBaseOffset: runState.persistedSessionBaseOffset,
							status: startedState,
							startedAt: runState.startedAt,
							elapsedMs: runState.elapsedMs,
							lastActivityAt: runState.lastActivityAt,
							thoughtText: runState.thoughtText,
							runtime: runState.runtime,
							claudeSessionId: runState.claudeSessionId,
							claudeProjectDir: runState.claudeProjectDir,
						},
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			}

			ctx.ui.notify(
				`${
					continuedFromRunId !== undefined
						? `Resumed subagent #${runId}: ${selectedAgent}`
						: `Started subagent #${runId}: ${selectedAgent}`
				} (${contextLabel} · turn ${runState.turnCount})`,
				"info",
			);

			const tick = setInterval(() => {
				const current = store.commandRuns.get(runId);
				if (current?.status !== "running") {
					clearInterval(tick);
					return;
				}
				current.elapsedMs = Date.now() - current.startedAt;
				updateCommandRunsWidget(store);
			}, RUN_TICK_INTERVAL_MS);

			let claudeCheckpointSent = !!runState.claudeSessionId;
			void (async () => {
				try {
					const { result, retryCount } = await invokeWithAutoRetry({
						maxRetries: MAX_SUBAGENT_AUTO_RETRIES,
						signal: abortController.signal,
						onRetryScheduled: ({ retryIndex, maxRetries, delayMs, reason }) => {
							runState.retryCount = retryIndex;
							runState.lastRetryReason = reason;
							runState.lastActivityAt = Date.now();
							runState.lastLine = `Auto-retrying ${retryIndex}/${maxRetries} in ${Math.ceil(delayMs / 1000)}s: ${reason}`;
							runState.lastOutput = runState.lastLine;
							updateCommandRunsWidget(store);
							ctx.ui.notify(`subagent #${runId} retry ${retryIndex}/${maxRetries}: ${reason}`, "warning");
						},
						invoke: () => {
							runState.persistedSessionBaseOffset = getSessionFileSize(runState.sessionFile);
							return enqueueSubagentInvocation(() =>
								runSingleAgent(
									ctx.cwd,
									agents,
									selectedAgent,
									taskForAgent,
									undefined,
									abortController.signal,
									(partial) => {
										if (runState.removed || store.disposed) return;
										const current = partial.details?.results?.[0];
										if (!current) return;
										updateRunFromResult(runState, current);
										if (!claudeCheckpointSent && runState.claudeSessionId) {
											claudeCheckpointSent = true;
											if (!hiddenFromMain) {
												pi.sendMessage(
													{
														customType: "subagent-command" as const,
														content: `[subagent:${selectedAgent}#${runId}] checkpoint`,
														display: false,
														details: {
															runId,
															agent: selectedAgent,
															task: taskForDisplay,
															displayTask: runState.displayTask,
															continuedFromRunId,
															turnCount: runState.turnCount,
															contextMode: runState.contextMode,
															sessionFile: runState.sessionFile,
															persistedSessionBaseOffset: runState.persistedSessionBaseOffset,
															status: "started",
															startedAt: runState.startedAt,
															elapsedMs: runState.elapsedMs,
															lastActivityAt: runState.lastActivityAt,
															runtime: runState.runtime,
															claudeSessionId: runState.claudeSessionId,
															claudeProjectDir: runState.claudeProjectDir,
														},
													},
													{ deliverAs: "followUp", triggerTurn: false },
												);
											}
										}
										updateCommandRunsWidget(store);
									},
									makeDetails,
									{
										sessionFile: runState.sessionFile,
										resumeSessionId: runState.claudeSessionId,
										sidecarSessionFile: runState.sessionFile,
										persistedSessionBaseOffset: runState.persistedSessionBaseOffset,
									},
								),
							);
						},
					});
					runState.retryCount = retryCount;

					if (runState.removed || store.disposed) return;

					updateRunFromResult(runState, result);
					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					runState.status = isError ? "error" : "done";
					runState.elapsedMs = Date.now() - runState.startedAt;
					updateCommandRunsWidget(store);

					const rawOutput = isError
						? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
						: getFinalOutput(result.messages) || "(no output)";
					const output =
						isError && rawOutput.length > RUN_OUTPUT_MESSAGE_MAX_CHARS
							? `${rawOutput.slice(0, RUN_OUTPUT_MESSAGE_MAX_CHARS)}\n\n... [truncated]`
							: rawOutput;
					const usage = formatUsageStats(result.usage, result.model);

					runState.lastOutput = rawOutput;
					if (rawOutput) runState.lastLine = getLastNonEmptyLine(rawOutput);

					const completionMessage = {
						customType: "subagent-command" as const,
						content:
							`[subagent:${selectedAgent}#${runId}] ${isError ? "failed" : "completed"}` +
							`\nPrompt: ${truncateLines(taskForDisplay, 2)}` +
							(usage ? `\nUsage: ${usage}` : "") +
							(runState.retryCount ? `\nRetries: ${runState.retryCount}/${MAX_SUBAGENT_AUTO_RETRIES}` : "") +
							(runState.thoughtText ? `\nThought: ${runState.thoughtText}` : "") +
							`\n\n${output}`,
						display: true,
						details: {
							runId,
							agent: selectedAgent,
							task: taskForDisplay,
							displayTask: runState.displayTask,
							continuedFromRunId,
							turnCount: runState.turnCount,
							contextMode: runState.contextMode,
							sessionFile: runState.sessionFile,
							persistedSessionBaseOffset: runState.persistedSessionBaseOffset,
							startedAt: runState.startedAt,
							elapsedMs: runState.elapsedMs,
							lastActivityAt: runState.lastActivityAt,
							exitCode: result.exitCode,
							usage: result.usage,
							model: result.model,
							source: result.agentSource,
							thoughtText: runState.thoughtText,
							retryCount: runState.retryCount,
							status: runState.status,
							runtime: runState.runtime,
							claudeSessionId: runState.claudeSessionId,
							claudeProjectDir: runState.claudeProjectDir,
						},
					};
					if (hiddenFromMain) {
						finalizeHumanOnlyCompletion(
							store,
							ctx,
							runId,
							`Hidden subagent #${runId} · ${selectedAgent}`,
							completionMessage.content,
							isError
								? `hidden subagent #${runId} (${selectedAgent}) failed`
								: `hidden subagent #${runId} (${selectedAgent}) completed`,
							isError ? "error" : "info",
						);
					} else {
						deliverOrQueueCompletion(store, pi, ctx, runId, runState, completionMessage);
						ctx.ui.notify(
							isError
								? `subagent #${runId} (${selectedAgent}) failed`
								: `subagent #${runId} (${selectedAgent}) completed`,
							isError ? "error" : "info",
						);
					}
				} catch (error: any) {
					if (runState.removed || store.disposed) return;
					runState.status = "error";
					runState.elapsedMs = Date.now() - runState.startedAt;
					runState.lastLine =
						runState.autoAbortReason ?? (error?.message ? String(error.message) : "Subagent execution failed");
					runState.lastOutput = runState.lastLine;

					const cmdErrorMessage = {
						customType: "subagent-command" as const,
						content:
							`[subagent:${selectedAgent}#${runId}] failed` +
							`\nPrompt: ${truncateLines(taskForDisplay, 2)}` +
							`\n\n${runState.lastLine}`,
						display: true,
						details: {
							runId,
							agent: selectedAgent,
							task: taskForDisplay,
							displayTask: runState.displayTask,
							continuedFromRunId,
							turnCount: runState.turnCount,
							contextMode: runState.contextMode,
							sessionFile: runState.sessionFile,
							persistedSessionBaseOffset: runState.persistedSessionBaseOffset,
							startedAt: runState.startedAt,
							elapsedMs: runState.elapsedMs,
							lastActivityAt: runState.lastActivityAt,
							error: runState.lastLine,
							thoughtText: runState.thoughtText,
							status: runState.status,
							runtime: runState.runtime,
							claudeSessionId: runState.claudeSessionId,
							claudeProjectDir: runState.claudeProjectDir,
						},
					};
					if (hiddenFromMain) {
						finalizeHumanOnlyCompletion(
							store,
							ctx,
							runId,
							`Hidden subagent #${runId} · ${selectedAgent}`,
							cmdErrorMessage.content,
							`hidden subagent #${runId} failed: ${runState.lastLine}`,
							"error",
						);
					} else {
						deliverOrQueueCompletion(store, pi, ctx, runId, runState, cmdErrorMessage);
						ctx.ui.notify(`subagent #${runId} failed: ${runState.lastLine}`, "error");
					}
				} finally {
					clearInterval(tick);
					runState.abortController = undefined;
					if (!store.disposed) {
						trimCommandRunHistory(store, {
							maxRuns: 10,
							ctx,
							pi,
							updateWidget: false,
							removalReason: "trim",
						});
						updateCommandRunsWidget(store);
					}
				}
			})();
		},
	};

	pi.registerCommand("sub:isolate", subCommand);

	pi.registerCommand("sub:main", {
		description: "Run a subagent with main-session context inheritance: /sub:main <agent|alias> <task>",
		getArgumentCompletions: subCommand.getArgumentCompletions,
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			const forwarded = (args ?? "").trim();
			await subCommand.handler(forwarded, ctx, true);
		},
	});

	pi.registerCommand("subagents", {
		description: "List available subagents and their model/thinking/tool settings",
		handler: async (_args, ctx) => {
			captureSwitchSession(store, ctx);
			const discovery = discoverAgents(ctx.cwd);
			const agents = discovery.agents;
			if (agents.length === 0) {
				ctx.ui.notify("No subagents found.", "warning");
				return;
			}

			const lines = agents.map((a) => {
				const tools = a.tools?.join(",") ?? "default";
				const model = a.model ?? "(inherit current model)";
				const thinking = a.thinking ?? "(inherit current thinking)";
				const description = a.description ? ` · ${a.description}` : "";
				const colorCode = AGENT_NAME_PALETTE[agentBgIndex(a.name)];
				const coloredName = `\x1b[38;5;${colorCode}m${a.name}\x1b[39m`;
				return truncateText(
					`${coloredName} [${a.source}] · model: ${model} · thinking: ${thinking} · tools: ${tools}${description}`,
					220,
				);
			});

			ctx.ui.notify(`Available subagents\n${lines.map((line) => `• ${line}`).join("\n")}`, "info");
		},
	});

	pi.registerCommand("sub:peek", {
		description: "Show the latest response from a subagent in an overlay: /sub:peek [runId]",
		getArgumentCompletions: (argumentPrefix) => {
			const trimmedStart = argumentPrefix.trimStart();
			if (trimmedStart.includes(" ")) return null;

			const items = Array.from(store.commandRuns.values())
				.sort((a, b) => b.id - a.id)
				.filter((run) => !trimmedStart || run.id.toString().startsWith(trimmedStart))
				.slice(0, COMMAND_COMPLETION_LIMIT)
				.map((run) => ({
					value: `${run.id}`,
					label: `${run.id}`,
					description: `${run.status} ${run.agent}: ${truncateText(run.task, COMMAND_TASK_PREVIEW_CHARS)}`,
				}));

			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			await subPeekHandler(args, ctx, store);
		},
	});

	pi.registerCommand("sub:open", {
		description: "Open a subagent session replay overlay: /sub:open [runId]",
		getArgumentCompletions: (argumentPrefix) => {
			const trimmedStart = argumentPrefix.trimStart();
			if (trimmedStart.includes(" ")) return null;

			const items = Array.from(store.commandRuns.values())
				.sort((a, b) => b.id - a.id)
				.filter((run) => !trimmedStart || run.id.toString().startsWith(trimmedStart))
				.slice(0, COMMAND_COMPLETION_LIMIT)
				.map((run) => ({
					value: `${run.id}`,
					label: `${run.id}`,
					description: `${run.status} ${run.agent}: ${truncateText(run.task, COMMAND_TASK_PREVIEW_CHARS)}`,
				}));

			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			const raw = (args ?? "").trim();
			let id: number;
			let run: CommandRunState | undefined;

			if (!raw) {
				run = getLatestRun(store);
				if (!run) {
					ctx.ui.notify("No subagent runs yet.", "info");
					return;
				}
				id = run.id;
			} else if (/^\d+$/.test(raw)) {
				id = Number(raw);
				run = store.commandRuns.get(id);
			} else {
				ctx.ui.notify("Usage: /sub:open [runId]", "info");
				return;
			}
			if (!run) {
				const availableRunIds = Array.from(store.commandRuns.keys()).sort((a, b) => a - b);
				const availableText =
					availableRunIds.length > 0
						? `Available run IDs: ${availableRunIds.join(", ")}`
						: "No recent subagent runs available.";
				ctx.ui.notify(`Unknown subagent run #${id}. ${availableText}`, "error");
				return;
			}

			const elapsedSec = Math.max(0, Math.round(run.elapsedMs / MS_PER_SECOND));
			const usageLine = run.usage ? `\nUsage: ${formatUsageStats(run.usage, run.model)}` : "";
			const output = (run.lastOutput ?? "").trim();
			const fallback =
				run.status === "running" ? "(still running; no final output yet)" : run.lastLine || "(no output captured)";
			const contextLabel = run.contextMode === "main" ? "main" : "isolated";
			const content =
				`Subagent #${run.id} [${run.status}] ${run.agent} ctx:${contextLabel} turn:${run.turnCount ?? DEFAULT_TURN_COUNT} ${elapsedSec}s tools:${run.toolCalls}` +
				`\n${run.task}` +
				usageLine +
				`\n\n${output || fallback}`;

			if (!ctx.hasUI) {
				return;
			}

			if (!run.sessionFile || !fs.existsSync(run.sessionFile)) {
				ctx.ui.notify(content, "info");
				return;
			}

			const replayItems = readSessionReplayItems(run.sessionFile);
			if (replayItems.length === 0) {
				ctx.ui.notify(content, "info");
				return;
			}

			await ctx.ui.custom(
				(tui, theme, _kb, done) => {
					const overlay = new SubagentSessionReplayOverlay(run, replayItems, () => done(undefined));
					return {
						render: (w) => overlay.render(w, 0 /* height computed internally */, theme),
						handleInput: (data) => overlay.handleInput(data, tui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: SUBVIEW_OVERLAY_WIDTH, maxHeight: SUBVIEW_OVERLAY_MAX_HEIGHT, anchor: "center" },
				},
			);
		},
	});

	pi.registerCommand("sub:history", {
		description: "Show all subagent run history (including removed) in an overlay: /sub:history",
		handler: async (_args, ctx) => {
			captureSwitchSession(store, ctx);

			const allRuns = Array.from(store.commandRuns.values()).sort((a, b) => b.startedAt - a.startedAt);

			if (allRuns.length === 0) {
				ctx.ui.notify("No subagent run history yet.", "info");
				return;
			}

			if (!ctx.hasUI) {
				// Fallback: plain text list
				const lines = allRuns.map((r) => {
					const removed = r.removed ? " [removed]" : "";
					const task = r.task
						.replace(/\s*\n+\s*/g, " ")
						.trim()
						.slice(0, COMMAND_TASK_PREVIEW_CHARS);
					return `#${r.id} [${r.status}]${removed} ${r.agent}: ${task}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			ctx.ui.setWidget("pixel-subagents", undefined);

			await ctx.ui.custom(
				(tui, theme, _kb, done) => {
					const overlay = new SubagentHistoryOverlay(
						allRuns,
						async (run) => {
							done(undefined);
							await subPeekHandler(run.id.toString(), ctx, store);
						},
						() => done(undefined),
					);
					return {
						render: (w) => overlay.render(w, 0, theme),
						handleInput: (data) => overlay.handleInput(data, tui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: SUBVIEW_OVERLAY_WIDTH, maxHeight: SUBVIEW_OVERLAY_MAX_HEIGHT, anchor: "center" },
				},
			);
		},
	});

	pi.registerCommand("sub:rm", {
		description: "Remove one /sub job entry (aborts it if running): /sub:rm [runId]",
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			const raw = (args ?? "").trim();
			let id: number;
			let run: CommandRunState | undefined;

			if (!raw) {
				run = getLatestRun(store);
				if (!run) {
					ctx.ui.notify("No subagent runs to remove.", "info");
					return;
				}
				id = run.id;
			} else if (/^\d+$/.test(raw)) {
				id = Number(raw);
				run = store.commandRuns.get(id);
			} else {
				ctx.ui.notify("Usage: /sub:rm [runId]", "info");
				return;
			}
			if (!run) {
				ctx.ui.notify(`Unknown subagent run #${id}.`, "error");
				return;
			}

			const { aborted } = removeRun(store, id, {
				ctx,
				pi,
				reason: "Aborting by /sub:rm...",
				removalReason: "sub-rm",
			});
			ctx.ui.notify(
				aborted ? `Removed subagent #${id} (aborting in background).` : `Removed subagent #${id}.`,
				aborted ? "warning" : "info",
			);
		},
	});

	const handleSubClear = async (args: string, ctx: any) => {
		captureSwitchSession(store, ctx);
		const mode = (args ?? "").trim().toLowerCase();
		if (mode === "all") {
			let removed = 0;
			let aborted = 0;
			for (const id of Array.from(store.commandRuns.keys())) {
				const result = removeRun(store, id, {
					ctx,
					pi,
					updateWidget: false,
					reason: "Aborting by /sub:clear all...",
					removalReason: "sub-clear",
				});
				if (!result.removed) continue;
				removed++;
				if (result.aborted) aborted++;
			}
			updateCommandRunsWidget(store, ctx as unknown as WidgetRenderCtx);
			ctx.ui.notify(
				aborted > 0
					? `Cleared ${removed} subagent job(s), aborting ${aborted} running job(s).`
					: `Cleared ${removed} subagent job(s).`,
				aborted > 0 ? "warning" : "info",
			);
			return;
		}

		let removed = 0;
		for (const [id, run] of Array.from(store.commandRuns.entries())) {
			if (run.status === "running") continue;
			const result = removeRun(store, id, {
				ctx,
				pi,
				updateWidget: false,
				abortIfRunning: false,
				removalReason: "sub-clear",
			});
			if (result.removed) removed++;
		}
		updateCommandRunsWidget(store, ctx as unknown as WidgetRenderCtx);
		ctx.ui.notify(`Cleared ${removed} finished subagent job(s).`, "info");
	};

	pi.registerCommand("sub:clear", {
		description: "Clear /sub job widget entries. /sub:clear (finished only) or /sub:clear all",
		handler: async (args, ctx) => {
			await handleSubClear(args, ctx);
		},
	});

	const handleSubAbort = async (args: string, ctx: any) => {
		const raw = (args ?? "").trim().toLowerCase();
		const running = Array.from(store.commandRuns.values())
			.filter((run) => run.status === "running")
			.sort((a, b) => b.id - a.id);

		if (running.length === 0) {
			ctx.ui.notify("No running subagent jobs.", "info");
			return;
		}

		const abortRun = (run: CommandRunState): boolean => {
			// Try the run's own controller first, then fall back to globalLiveRuns
			// (the run's controller may have been cleared after a session switch).
			const controller = run.abortController ?? store.globalLiveRuns.get(run.id)?.abortController;
			if (!controller) return false;
			run.lastLine = "Aborting by user...";
			run.lastOutput = run.lastLine;
			controller.abort();
			return true;
		};

		if (!raw) {
			const target = running[0];
			if (!abortRun(target)) {
				ctx.ui.notify(`Subagent #${target.id} is not abortable right now.`, "warning");
				return;
			}
			updateCommandRunsWidget(store, ctx as unknown as WidgetRenderCtx);
			ctx.ui.notify(`Aborting subagent #${target.id} (${target.agent})...`, "warning");
			return;
		}

		if (raw === "all") {
			let count = 0;
			for (const run of running) {
				if (abortRun(run)) count++;
			}
			updateCommandRunsWidget(store, ctx as unknown as WidgetRenderCtx);
			ctx.ui.notify(
				count > 0 ? `Aborting ${count} running subagent job(s)...` : "No abortable subagent jobs.",
				count > 0 ? "warning" : "info",
			);
			return;
		}

		if (/^\d+$/.test(raw)) {
			const id = Number(raw);
			const run = store.commandRuns.get(id);
			if (!run) {
				ctx.ui.notify(`Unknown subagent run #${id}.`, "error");
				return;
			}
			if (run.status !== "running") {
				ctx.ui.notify(`Subagent #${id} is not running.`, "info");
				return;
			}
			if (!abortRun(run)) {
				ctx.ui.notify(`Subagent #${id} is not abortable right now.`, "warning");
				return;
			}
			updateCommandRunsWidget(store, ctx as unknown as WidgetRenderCtx);
			ctx.ui.notify(`Aborting subagent #${id} (${run.agent})...`, "warning");
			return;
		}

		ctx.ui.notify("Usage: /sub:abort [runId|all]", "info");
	};

	pi.registerCommand("sub:abort", {
		description: "Abort running subagent job(s). /sub:abort [runId|all]",
		handler: async (args, ctx) => {
			captureSwitchSession(store, ctx);
			await handleSubAbort(args, ctx);
		},
	});

	// Only actual keyboard shortcuts appear in the /hotkeys Extensions section.
	// NOTE: plain ">" is a real keybinding and hijacks editor text input,
	// so hidden subagent prefixes are documented via footer/status hints instead.
	pi.registerShortcut(">>" as any, {
		description: "Run subagent task",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.registerShortcut(">>>" as any, {
		description: "Run hidden subagent (legacy alias, interactive UI only, supports symbols)",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const text = event.text ?? "";
		if (!text.startsWith(">")) return { action: "continue" as const };

		const symbolMap = loadSubagentConfig(ctx.cwd).symbolMap;
		const legacySymbol = text.length > 3 && text[3] !== " " ? symbolMap[text[3]] : undefined;
		const hiddenSymbol = text.length > 1 && text[1] !== " " && text[1] !== "<" ? symbolMap[text[1]] : undefined;
		const isLegacyHiddenShortcut = text === ">>>" || text.startsWith(">>> ") || Boolean(legacySymbol);
		const isVisibleShortcut = text.startsWith(">>") && !isLegacyHiddenShortcut;
		const isHiddenShortcut = !isVisibleShortcut && (text === ">" || text.startsWith("> ") || Boolean(hiddenSymbol));
		if (!isLegacyHiddenShortcut && !isVisibleShortcut && !isHiddenShortcut) {
			return { action: "continue" as const };
		}

		const handleHiddenShortcut = async (prefix: ">" | ">>>") => {
			if (!ctx.hasUI) {
				pi.sendMessage(
					{
						customType: "subagent-command",
						content: "Hidden subagent mode requires interactive UI. Use /sub:isolate instead.",
						display: true,
						details: {},
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
				return;
			}

			const symbolMap = loadSubagentConfig(ctx.cwd).symbolMap;
			const forwardedArgs = text.slice(prefix.length).trim();
			if (!forwardedArgs) {
				ctx.ui.notify(
					`${prefix} [agent] <task> | ${prefix} <runId> <task> | ${prefix}<symbol> <task>\n${formatSymbolHints(symbolMap, prefix)}`,
					"info",
				);
				return;
			}

			const dedicatedSymbol = symbolMap[forwardedArgs[0]];
			if (dedicatedSymbol) {
				const task = forwardedArgs.slice(1).trim();
				if (!task) {
					ctx.ui.notify(formatSymbolHints(symbolMap, prefix), "info");
					return;
				}
				await subCommand.handler(`${dedicatedSymbol} ${task}`, ctx, true, true);
				return;
			}

			const firstSpace = forwardedArgs.indexOf(" ");
			const firstToken = firstSpace === -1 ? forwardedArgs : forwardedArgs.slice(0, firstSpace);
			if (/^\d+$/.test(firstToken) && !store.commandRuns.has(Number(firstToken))) {
				ctx.ui.notify(`Unknown subagent run #${firstToken}.`, "error");
				return;
			}
			await subCommand.handler(forwardedArgs, ctx, true, true);
		};

		if (isLegacyHiddenShortcut) {
			await handleHiddenShortcut(">>>");
			return { action: "handled" as const };
		}
		if (isHiddenShortcut) {
			await handleHiddenShortcut(">");
			return { action: "handled" as const };
		}

		// ── Configured symbol shortcut: >><symbol> task ──
		if (text.length >= 3) {
			const symbolChar = text[2];
			const symbolAgent = symbolChar !== " " ? symbolMap[symbolChar] : undefined;
			if (symbolAgent) {
				const task = text.slice(3).trim();
				if (!task) {
					ctx.ui.notify(formatSymbolHints(symbolMap), "info");
					return { action: "handled" as const };
				}
				await subCommand.handler(`${symbolAgent} ${task}`, ctx, true);
				return { action: "handled" as const };
			}
		}

		// ── Original >> <args> pattern ──
		if (text[2] !== " ") {
			return { action: "continue" as const };
		}

		const forwardedArgs = text.slice(3).trim();
		if (!forwardedArgs) {
			const symbolHelp = formatSymbolHints(symbolMap);
			ctx.ui.notify(
				`>> [agent] <task> | >> <runId> <task>${symbolHelp ? ` | >><symbol> <task>\n${symbolHelp}` : ""}`,
				"info",
			);
			return { action: "handled" as const };
		}

		const firstSpace = forwardedArgs.indexOf(" ");
		const firstToken = firstSpace === -1 ? forwardedArgs : forwardedArgs.slice(0, firstSpace);
		if (/^\d+$/.test(firstToken) && !store.commandRuns.has(Number(firstToken))) {
			ctx.ui.notify(`Unknown subagent run #${firstToken}.`, "error");
			return { action: "handled" as const };
		}

		await subCommand.handler(forwardedArgs, ctx, true);
		return { action: "handled" as const };
	});

	// #<runId> shortcut: resume a subagent run (e.g. #42 keep going)
	pi.registerShortcut("#<runId>" as any, {
		description: "Resume subagent run: #<runId> <task>",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const text = event.text ?? "";

		// Match #<digits> pattern (e.g. #42 task, #7 keep going)
		const match = /^#(\d+)\s(.+)/.exec(text);
		if (!match) {
			return { action: "continue" as const };
		}

		const runId = match[1];
		const task = match[2].trim();

		if (!task) {
			ctx.ui.notify("Usage: #<runId> <task>", "info");
			return { action: "handled" as const };
		}

		if (!store.commandRuns.has(Number(runId))) {
			ctx.ui.notify(`Unknown subagent run #${runId}.`, "error");
			return { action: "handled" as const };
		}

		await subCommand.handler(`${runId} ${task}`, ctx, true);
		return { action: "handled" as const };
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const text = event.text ?? "";
		const compactPeekMatch = /^<>(\d+)$/.exec(text.trim());
		if (!compactPeekMatch?.[1]) {
			return { action: "continue" as const };
		}

		await subPeekHandler(compactPeekMatch[1], ctx, store);
		return { action: "handled" as const };
	});

	// << shortcut: abort running jobs or clear finished jobs
	pi.registerShortcut("<<" as any, {
		description: "Abort or clear subagent runs",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.registerShortcut("<<<" as any, {
		description: "Clear finished subagent jobs (= /sub:clear). <<< all to clear all",
		handler: async () => {
			// Documentation-only entry.
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const text = event.text ?? "";
		if (!text.startsWith("<<")) {
			return { action: "continue" as const };
		}

		// ── <<< shortcut: clear finished jobs (same as /sub:clear) ──
		// Must be matched before << patterns.
		if (text.startsWith("<<<")) {
			const clearArgs = text.slice(3).trim();
			await handleSubClear(clearArgs, ctx);
			return { action: "handled" as const };
		}

		const raw = text.slice(2).trim();

		// << 1,2,3 — multiple run IDs (comma-separated)
		// << 1 — single run ID
		// << (no args) — latest running run only
		const ids = raw
			? raw
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: [];

		if (ids.length === 0) {
			// No args: abort latest running job only.
			// Never auto-clear finished runs — too dangerous on accidental <<.
			const running = Array.from(store.commandRuns.values())
				.filter((r) => r.status === "running")
				.sort((a, b) => b.id - a.id);
			if (running.length > 0) {
				await handleSubAbort("", ctx);
			} else {
				ctx.ui.notify("No running jobs. Use << <id> or /sub:clear.", "info");
			}
			return { action: "handled" as const };
		}

		// Validate all IDs are numeric
		if (!ids.every((id) => /^\d+$/.test(id))) {
			ctx.ui.notify("Usage: << [runId,runId,...]", "info");
			return { action: "handled" as const };
		}

		let aborted = 0;
		let cleared = 0;
		const unknown: string[] = [];
		for (const idStr of ids) {
			const id = Number(idStr);
			const run = store.commandRuns.get(id);
			if (!run) {
				unknown.push(idStr);
				continue;
			}
			const shortcutController = run.abortController ?? store.globalLiveRuns.get(id)?.abortController;
			if (run.status === "running" && shortcutController) {
				run.lastLine = "Aborting by user...";
				run.lastOutput = run.lastLine;
				shortcutController.abort();
				aborted++;
			} else if (run.status !== "running") {
				const result = removeRun(store, id, {
					ctx,
					pi,
					updateWidget: false,
					abortIfRunning: false,
					removalReason: "shortcut-clear",
				});
				if (result.removed) cleared++;
			}
		}
		updateCommandRunsWidget(store, ctx as unknown as WidgetRenderCtx);

		const parts: string[] = [];
		if (aborted) parts.push(`${aborted} aborted`);
		if (cleared) parts.push(`${cleared} cleared`);
		if (unknown.length) parts.push(`#${unknown.join(",#")} not found`);
		ctx.ui.notify(parts.join(", ") || "Nothing to do.", parts.length ? (aborted ? "warning" : "info") : "info");
		return { action: "handled" as const };
	});

	// ── onTerminalInput hack: auto-redirect <>7 to /sub:peek 7 ───────────
	let unsubTerminalInput: (() => void) | null = null;

	function registerTerminalInputRedirect(ctx: any): void {
		// Unsubscribe previous listener to avoid duplicates on session change.
		unsubTerminalInput?.();
		unsubTerminalInput = null;

		unsubTerminalInput = ctx.ui.onTerminalInput((data: string) => {
			// Only intercept Enter key (all terminal variants).
			if (!matchesKey(data, "enter")) return undefined;

			const editorText = (ctx.ui.getEditorText() ?? "").trim();

			// <>7  →  /sub:peek 7
			const compactPeekMatch = /^<>(\d+)$/.exec(editorText);
			if (compactPeekMatch?.[1]) {
				ctx.ui.setEditorText(`/sub:peek ${compactPeekMatch[1]}`);
				return undefined; // let Enter proceed with rewritten text
			}

			return undefined;
		});
	}

	// ── Persona injection for sub-trans child sessions ──────────────────
	// When the user switches into a subagent session via <> / /sub:trans
	// and sends normal chat prompts, prepend the subagent's system prompt
	// so the main agent responds with that persona.
	const PERSONA_MARKER = "<!-- subagent-persona-injected -->";

	pi.on("before_agent_start", async (event, ctx) => {
		// Skip if persona marker already present (avoid double-inject)
		if (event.systemPrompt.includes(PERSONA_MARKER)) return;

		// Find latest PARENT_ENTRY_TYPE entry to determine if this is a sub-trans child session
		let latestEntry: any = null;
		try {
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			for (const entry of entries) {
				if ((entry as any).type === "custom" && (entry as any).customType === PARENT_ENTRY_TYPE) {
					latestEntry = entry;
				}
			}
		} catch {
			return;
		}

		if (!latestEntry?.data) return;

		// Resolve agent name: data.agent (new entries) or fallback via runId (legacy entries)
		let agentName: string | undefined = latestEntry.data.agent;
		if (!agentName && latestEntry.data.runId != null) {
			agentName = store.commandRuns.get(latestEntry.data.runId)?.agent;
		}
		if (!agentName) return;

		// Discover agents and find exact match
		const discovery = discoverAgents(ctx.cwd);
		const agentConfig = discovery.agents.find((a) => a.name.toLowerCase() === agentName?.toLowerCase());
		if (!agentConfig?.systemPrompt?.trim()) return;

		// Prepend persona block with marker
		const personaBlock = `${PERSONA_MARKER}\n${agentConfig.systemPrompt}`;
		return {
			systemPrompt: `${personaBlock}\n\n${event.systemPrompt}`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreRunsFromSession(store, ctx, pi);
		registerTerminalInputRedirect(ctx);
	});

	pi.on("session_shutdown", () => {
		unsubTerminalInput?.();
		unsubTerminalInput = null;
	});
}
