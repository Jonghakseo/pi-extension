/**
 * Subagent run status widget — renders per-run status boxes above the editor.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { HANG_WARNING_IDLE_MS, PARENT_HINT } from "./constants.js";
import {
	AGENT_NAME_PALETTE,
	agentBgIndex,
	getContextBarColorByRemaining,
	getRemainingContextPercent,
	getUsedContextPercent,
	resolveContextWindow,
	truncatePlainToWidth,
} from "./format.js";

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const SPINNER_INTERVAL_MS = 120;
const SPINNER_REFRESH_MS = 150;

const MAX_VISIBLE_RUNS = 3;
const MAX_TASK_LABEL_CHARS = 144;

import { type SubagentStore, truncateText } from "./store.js";
import type { CommandRunState } from "./types.js";

type ThemeBg = Parameters<Theme["bg"]>[0];
type WidgetTheme = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
	bg: (color: ThemeBg, text: string) => string;
};

type WidgetFactory = (
	tui: unknown,
	theme: WidgetTheme,
) => {
	render(width: number): string[];
	invalidate?(): void;
	dispose?(): void;
};

type WidgetPlacementOptions = { placement?: "aboveEditor" | "belowEditor" };

type WidgetSetWidget = {
	(key: string, content: string[] | undefined, options?: WidgetPlacementOptions): void;
	(key: string, content: WidgetFactory | undefined, options?: WidgetPlacementOptions): void;
};

export type WidgetRenderCtx = {
	hasUI?: boolean;
	ui?: {
		setWidget: WidgetSetWidget;
	};
	model?: { contextWindow?: number };
	modelRegistry?: {
		getAll: () => Array<{ provider: string; id: string; contextWindow?: number }>;
	};
};

/** Fast timer that drives spinner animation while any run is active. */
let spinnerTimer: ReturnType<typeof setInterval> | undefined;

function manageSpinnerTimer(store: SubagentStore): void {
	const hasRunning = Array.from(store.commandRuns.values()).some((r) => r.status === "running");
	if (hasRunning && !spinnerTimer) {
		spinnerTimer = setInterval(() => updateCommandRunsWidget(store), SPINNER_REFRESH_MS);
	} else if (!hasRunning && spinnerTimer) {
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}
}

export function cleanupCommandRunsWidgetTimer(): void {
	if (!spinnerTimer) return;
	clearInterval(spinnerTimer);
	spinnerTimer = undefined;
}

function getStatusVisual(run: CommandRunState): { statusColor: ThemeColor; statusIcon: string } {
	const statusColor: ThemeColor = run.status === "running" ? "warning" : run.status === "done" ? "success" : "error";
	const spinnerFrame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
	const statusIcon = run.status === "running" ? spinnerFrame : run.status === "done" ? "✓" : "✗";
	return { statusColor, statusIcon };
}

function formatCompactDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

function getIdleLabel(run: CommandRunState, theme: WidgetTheme): string {
	if (run.status !== "running" || !run.lastActivityAt) return "";
	const idleMs = Date.now() - run.lastActivityAt;
	if (idleMs < 60_000) return "";
	const idleColor: ThemeColor = idleMs >= HANG_WARNING_IDLE_MS ? "error" : "dim";
	return theme.fg(idleColor, `idle:${formatCompactDuration(idleMs)}`);
}

const WIDGET_BAR_WIDTH = 5;

function formatCompactContextBar(percent: number): string {
	const clamped = Math.max(0, Math.min(100, Math.round(percent)));
	const filled = Math.round((clamped / 100) * WIDGET_BAR_WIDTH);
	if (filled <= 0) return "";
	return `[${"■".repeat(filled)}${"□".repeat(WIDGET_BAR_WIDTH - filled)}]`;
}

function getContextShort(run: CommandRunState, ctx: WidgetRenderCtx, theme: WidgetTheme): string {
	const contextWindow = resolveContextWindow(ctx, run.model);
	const usedContextPercent = getUsedContextPercent(run.usage?.contextTokens, contextWindow);
	const remainingContextPercent = getRemainingContextPercent(usedContextPercent);
	if (usedContextPercent === undefined) return "";
	const contextBar = formatCompactContextBar(usedContextPercent);
	if (!contextBar) return "";
	const contextLabel = `${contextBar} ${usedContextPercent}%`;
	const contextBarColor =
		remainingContextPercent !== undefined ? getContextBarColorByRemaining(remainingContextPercent) : undefined;
	return contextBarColor ? theme.fg(contextBarColor, contextLabel) : theme.fg("dim", contextLabel);
}

function buildPrimaryLabelText(run: CommandRunState): string {
	const lastLine = run.lastLine
		?.replace(/\s*\n+\s*/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	if (lastLine) return truncateText(lastLine, MAX_TASK_LABEL_CHARS);

	const displayTask = run.displayTask ?? run.task;
	return truncateText(displayTask.replace(/\s+/g, " ").trim(), MAX_TASK_LABEL_CHARS);
}

function joinParts(parts: string[], delimiter: string): string {
	return parts.filter(Boolean).join(delimiter);
}

function getPartsWidth(parts: Array<{ width: number }>, delimiterWidth: number): number {
	if (parts.length === 0) return 0;
	return parts.reduce((sum, part) => sum + part.width, 0) + delimiterWidth * (parts.length - 1);
}

function buildStatusLeft(run: CommandRunState, theme: WidgetTheme, maxWidth: number): string {
	if (maxWidth <= 0) return "";

	const { statusColor, statusIcon } = getStatusVisual(run);
	const delimiter = theme.fg("muted", " · ");
	const delimiterWidth = visibleWidth(" · ");
	const taskText = buildPrimaryLabelText(run);
	const idleLabel = getIdleLabel(run, theme);
	const statusLabel = theme.fg(statusColor, `${statusIcon} #${run.id}`);
	const isolatedBadge = run.contextMode === "sub" ? `${theme.fg("accent", "[I]")} ` : "";
	const agentLabel = `${isolatedBadge}\x1b[38;5;${AGENT_NAME_PALETTE[agentBgIndex(run.agent)]}m${run.agent}\x1b[39m`;
	const elapsedLabel = theme.fg("dim", formatCompactDuration(run.elapsedMs));

	const statusPart = { text: statusLabel, width: visibleWidth(statusLabel) };
	const agentPart = { text: agentLabel, width: visibleWidth(agentLabel) };
	const elapsedPart = { text: elapsedLabel, width: visibleWidth(elapsedLabel) };
	const idlePart = idleLabel ? { text: idleLabel, width: visibleWidth(idleLabel) } : undefined;

	const fixedLayouts = [
		[statusPart, agentPart, elapsedPart, idlePart].filter(Boolean),
		[statusPart, agentPart, elapsedPart],
		[statusPart, agentPart],
		[statusPart],
	] as Array<Array<{ text: string; width: number }>>;

	for (const fixedParts of fixedLayouts) {
		const baseWidth = getPartsWidth(fixedParts, delimiterWidth);
		if (!taskText) {
			if (baseWidth <= maxWidth)
				return joinParts(
					fixedParts.map((part) => part.text),
					delimiter,
				);
			continue;
		}

		const taskBudget = maxWidth - baseWidth - (fixedParts.length > 0 ? delimiterWidth : 0);
		if (taskBudget <= 0) continue;
		const truncatedTask = truncateText(taskText, Math.min(MAX_TASK_LABEL_CHARS, taskBudget));
		if (!truncatedTask) continue;
		return joinParts([...fixedParts.map((part) => part.text), theme.fg("dim", truncatedTask)], delimiter);
	}

	if (taskText) return theme.fg("dim", truncateText(taskText, maxWidth));
	return theme.fg(statusColor, truncateText(`${statusIcon} #${run.id}`, maxWidth));
}

function composeRunLine(run: CommandRunState, ctx: WidgetRenderCtx, theme: WidgetTheme, innerWidth: number): string {
	const right = getContextShort(run, ctx, theme);
	if (!right) return buildStatusLeft(run, theme, innerWidth);

	const fittedRight = truncateToWidth(right, innerWidth, theme.fg("dim", "..."));
	const rightWidth = visibleWidth(fittedRight);
	const leftBudget = Math.max(0, innerWidth - rightWidth - (innerWidth > rightWidth ? 1 : 0));
	const left = buildStatusLeft(run, theme, leftBudget);
	if (!left) return `${" ".repeat(Math.max(0, innerWidth - rightWidth))}${fittedRight}`;

	const gapWidth = Math.max(1, innerWidth - visibleWidth(left) - rightWidth);
	return `${left}${" ".repeat(gapWidth)}${fittedRight}`;
}

export function updateCommandRunsWidget(store: SubagentStore, ctx?: WidgetRenderCtx): void {
	const activeCtx = ctx ?? store.commandWidgetCtx;
	if (!activeCtx?.hasUI || !activeCtx.ui) return;
	store.commandWidgetCtx = activeCtx;
	const { ui } = activeCtx;

	// Parent session hint — visible when inside a child session (persistent parent link exists)
	if (store.currentParentSessionFile) {
		ui.setWidget(
			"sub-parent",
			(_tui: unknown, theme: WidgetTheme) => {
				const box = new Box(1, 0);
				const content = new Text("", 0, 0);
				box.addChild(content);
				return {
					render(width: number): string[] {
						const innerWidth = Math.max(1, width - 2);
						content.setText(theme.fg("accent", truncatePlainToWidth(PARENT_HINT, innerWidth)));
						return box.render(width);
					},
					invalidate() {
						box.invalidate();
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	} else {
		ui.setWidget("sub-parent", undefined);
	}

	const statusPriority = (status: "running" | "done" | "error") =>
		status === "running" ? 0 : status === "done" ? 1 : 2;
	// Show all subagent runs in the aboveEditor widget, regardless of how they were launched.
	const runs = Array.from(store.commandRuns.values())
		.filter((r) => !r.removed)
		.sort((a, b) => {
			const priorityDiff = statusPriority(a.status) - statusPriority(b.status);
			if (priorityDiff !== 0) return priorityDiff;
			const startedDiff = (b.startedAt ?? 0) - (a.startedAt ?? 0);
			if (startedDiff !== 0) return startedDiff;
			return b.id - a.id;
		})
		.slice(0, MAX_VISIBLE_RUNS);
	const visibleRunIds = new Set<number>(runs.map((run) => run.id));

	for (const id of Array.from(store.renderedRunWidgetIds)) {
		if (!visibleRunIds.has(id)) {
			ui.setWidget(`sub-${id}`, undefined);
			store.renderedRunWidgetIds.delete(id);
		}
	}

	if (runs.length === 0) {
		ui.setWidget("subagent-runs", undefined);
		manageSpinnerTimer(store);
		return;
	}

	ui.setWidget("subagent-runs", undefined);

	for (const run of runs) {
		store.renderedRunWidgetIds.add(run.id);
		ui.setWidget(
			`sub-${run.id}`,
			(_tui: unknown, theme: WidgetTheme) => {
				const box = new Box(1, 0);
				const content = new Text("", 0, 0);
				box.addChild(content);

				return {
					render(width: number): string[] {
						const innerWidth = Math.max(1, width - 2);
						content.setText(composeRunLine(run, activeCtx, theme, innerWidth));
						return box.render(width);
					},
					invalidate() {
						box.invalidate();
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	}

	manageSpinnerTimer(store);
}
