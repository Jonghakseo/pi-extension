import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { PENDING_AFTER_MS, STATUS_KEY, WIDGET_KEY } from "./constants.js";
import { displayPath } from "./context.js";
import { finalizeRunIfNeeded } from "./state.js";
import type { DisplayStatus, RunRecord, SetupContext, Snapshot } from "./types.js";
import { elapsedMs, formatDuration, getLogIdleMs, readLastLogLine, readLogTail } from "./utils.js";

export type Watcher = {
	context: SetupContext;
	interval: ReturnType<typeof setInterval>;
	snapshot: Snapshot | null;
	tui: TUI | null;
	disposed: boolean;
};

export function snapshotFromRecord(record: RunRecord, localPid = process.pid): Snapshot {
	const logIdleMs = getLogIdleMs(record.logPath, record.startedAt);
	const status: DisplayStatus = record.status === "running" && logIdleMs > PENDING_AFTER_MS ? "pending" : record.status;
	const message =
		record.status === "running" ? readLastLogLine(record.logPath) : (record.message ?? readLastLogLine(record.logPath));
	return {
		visible: true,
		status,
		repoRoot: record.repoRoot,
		owner: record.coordinatorPid === localPid ? "self" : "other",
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		exitCode: record.exitCode,
		message,
		logPath: record.logPath,
	};
}

export async function getSnapshot(context: SetupContext): Promise<Snapshot | null> {
	const record = await finalizeRunIfNeeded(context);
	if (!record || record.status === "success") return null;
	return snapshotFromRecord(record);
}

export function formatSnapshotLine(snapshot: Snapshot, theme: Pick<Theme, "fg">): string {
	const duration = formatDuration(elapsedMs(snapshot.startedAt, snapshot.finishedAt));
	const repo = displayPath(snapshot.repoRoot);
	const owner =
		snapshot.owner === "other" && (snapshot.status === "running" || snapshot.status === "pending") ? " elsewhere" : "";
	const exit = snapshot.exitCode !== undefined && snapshot.status !== "success" ? ` exit ${snapshot.exitCode}` : "";
	const suffix = snapshot.message ? ` · ${snapshot.message}` : "";

	if (snapshot.status === "success") return `${theme.fg("success", "✅")} setup.sh done ${duration} · ${repo}`;
	if (snapshot.status === "failed") {
		return `${theme.fg("error", "❌")} setup.sh failed${exit} · ${repo}${suffix} · /setup-sh`;
	}
	if (snapshot.status === "cancelled") return `${theme.fg("warning", "⚠️")} setup.sh cancelled · ${repo}${suffix}`;
	if (snapshot.status === "stale") {
		return `${theme.fg("warning", "⚠️")} setup.sh stale · ${repo}${suffix} · /setup-sh`;
	}
	if (snapshot.status === "pending") {
		return `${theme.fg("warning", "⏳")} setup.sh pending${owner} ${duration} · ${repo}${suffix}`;
	}
	return `${theme.fg("accent", "🔧")} setup.sh running${owner} ${duration} · ${repo}${suffix}`;
}

export function plainSnapshotLine(snapshot: Snapshot): string {
	return formatSnapshotLine(snapshot, { fg: (_color, text) => text });
}

export function renderWidgetLine(snapshot: Snapshot | null, width: number, theme: Pick<Theme, "fg">): string[] {
	if (!snapshot?.visible) return [];
	return [truncateToWidth(formatSnapshotLine(snapshot, theme), width, "…")];
}

export function updateStatus(ctx: ExtensionContext, snapshot: Snapshot | null): void {
	if (!snapshot?.visible) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	if (snapshot.status === "failed" || snapshot.status === "stale") {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", "❌ setup"));
		return;
	}
	if (snapshot.status === "pending") {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "⏳ setup"));
		return;
	}
	if (snapshot.status === "running") {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "🔧 setup"));
		return;
	}
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

export function installWidget(ctx: ExtensionContext, watcher: Watcher): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, (tui: TUI, theme: Theme) => {
		watcher.tui = tui;
		return {
			render: (width: number) => renderWidgetLine(watcher.snapshot, width || tui.terminal?.columns || 120, theme),
			invalidate: () => {},
		};
	});
}

export async function refreshWatcher(ctx: ExtensionContext, watcher: Watcher): Promise<void> {
	if (watcher.disposed) return;
	watcher.snapshot = await getSnapshot(watcher.context);
	updateStatus(ctx, watcher.snapshot);
	if (!watcher.snapshot) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	watcher.tui?.requestRender();
}

export function stopWatcher(ctx: ExtensionContext, watcher: Watcher | null): void {
	if (!watcher) return;
	watcher.disposed = true;
	clearInterval(watcher.interval);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

export async function showStatus(ctx: ExtensionContext, context: SetupContext): Promise<void> {
	const record = await finalizeRunIfNeeded(context);
	if (!record) {
		ctx.ui.notify(`setup.sh 상태 없음: ${displayPath(context.repoRoot)}`, "info");
		return;
	}
	const snapshot = snapshotFromRecord(record);
	const tail = readLogTail(record.logPath);
	const body = [plainSnapshotLine(snapshot), `Log: ${record.logPath}`, tail.length > 0 ? "" : undefined, ...tail]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	ctx.ui.notify(body, record.status === "failed" || record.status === "stale" ? "error" : "info");
}
