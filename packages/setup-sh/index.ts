import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PENDING_AFTER_MS, STATE_ROOT, STATUS_KEY, WIDGET_KEY, WIDGET_REFRESH_MS } from "./constants.js";
import { displayPath, findSetupPath, repoKeyFor, resolveSetupContext } from "./context.js";
import { cancelSetup, createWrapperScript, startSetup } from "./runner.js";
import { finalizeRunIfNeeded } from "./state.js";
import type { SetupContext, StartMode, StartResult } from "./types.js";
import { formatDuration, shellQuote, stripAnsi } from "./utils.js";
import {
	formatSnapshotLine,
	installWidget,
	refreshWatcher,
	renderWidgetLine,
	stopWatcher,
	type Watcher,
} from "./widget.js";

async function notifyStartResult(ctx: ExtensionContext, result: StartResult): Promise<void> {
	if (result.kind === "started") {
		ctx.ui.notify(`setup.sh 실행 시작: ${displayPath(result.context.repoRoot)}`, "info");
		return;
	}
	if (result.kind === "running") {
		ctx.ui.notify(`setup.sh가 이미 실행 중입니다: ${displayPath(result.context.repoRoot)}`, "info");
		return;
	}
	if (result.kind === "skipped") {
		ctx.ui.notify(result.reason, "info");
		return;
	}
	if (result.kind === "failed") {
		ctx.ui.notify(result.reason, "error");
	}
}

export const __test__ = {
	STATE_ROOT,
	PENDING_AFTER_MS,
	displayPath,
	findSetupPath,
	formatDuration,
	formatSnapshotLine,
	repoKeyFor,
	renderWidgetLine,
	resolveSetupContext,
	createWrapperScript,
	shellQuote,
	stripAnsi,
};

export default function setupShExtension(pi: ExtensionAPI): void {
	let watcher: Watcher | null = null;

	async function watch(ctx: ExtensionContext, context: SetupContext): Promise<void> {
		if (!ctx.hasUI) return;
		stopWatcher(ctx, watcher);
		watcher = {
			context,
			interval: setInterval(() => {
				if (watcher) void refreshWatcher(ctx, watcher);
			}, WIDGET_REFRESH_MS),
			snapshot: null,
			tui: null,
			disposed: false,
		};
		installWidget(ctx, watcher);
		await refreshWatcher(ctx, watcher);
	}

	async function runOrAttach(ctx: ExtensionContext, mode: StartMode): Promise<StartResult> {
		const result = await startSetup(ctx.cwd, mode);
		if (result.kind !== "no-setup" && result.kind !== "failed") await watch(ctx, result.context);
		return result;
	}

	pi.on("session_start", async (event, ctx) => {
		const context = resolveSetupContext(ctx.cwd);
		if (!context) {
			if (ctx.hasUI) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
			return;
		}

		if (event.reason === "reload") {
			await finalizeRunIfNeeded(context);
			await watch(ctx, context);
			return;
		}

		const result = await runOrAttach(ctx, "auto");
		if (!ctx.hasUI) return;
		if (result.kind === "started") {
			ctx.ui.notify(`setup.sh 자동 실행 시작: ${displayPath(result.context.repoRoot)}`, "info");
		}
		if (result.kind === "running") ctx.ui.notify(`setup.sh 실행 중: ${displayPath(result.context.repoRoot)}`, "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopWatcher(ctx, watcher);
		watcher = null;
	});

	pi.registerCommand("setup-sh", {
		description: "Run, rerun, or abort ./setup.sh in the current folder",
		handler: async (args, ctx) => {
			if (args.trim().length > 0) {
				ctx.ui.notify("사용법: /setup-sh", "warning");
				return;
			}

			const context = resolveSetupContext(ctx.cwd);
			if (!context) {
				ctx.ui.notify("현재 폴더에서 setup.sh를 찾지 못했습니다.", "warning");
				return;
			}

			const current = await finalizeRunIfNeeded(context);
			if (current?.status === "running") {
				const message = await cancelSetup(context);
				await watch(ctx, context);
				ctx.ui.notify(message, "warning");
				return;
			}

			await notifyStartResult(ctx, await runOrAttach(ctx, current ? "rerun" : "manual"));
		},
	});
}
