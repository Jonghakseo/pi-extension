/**
 * Legacy above-editor pixel subagent widget is disabled.
 *
 * All subagent runs are rendered by widget.ts in the above-editor run status widget regardless of launch source.
 */

import type { SubagentStore } from "./store.js";
import type { WidgetRenderCtx } from "./widget.js";

export function updatePixelWidget(store: SubagentStore, ctx?: Pick<WidgetRenderCtx, "hasUI" | "ui"> | null): void {
	const activeCtx = ctx ?? store.pixelWidgetCtx;
	if (!activeCtx?.hasUI) return;
	store.pixelWidgetCtx = activeCtx;
	activeCtx.ui?.setWidget("pixel-subagents", undefined);
}

export function cleanupPixelTimer(): void {
	// no-op: legacy pixel widget is disabled
	return;
}
