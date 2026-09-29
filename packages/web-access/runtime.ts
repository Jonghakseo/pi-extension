import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { activityMonitor } from "./activity.js";
import { updateWidget } from "./activity-widget.js";
import { registerCommands } from "./commands.js";
import { DEFAULT_SHORTCUTS, loadConfigForExtensionInit } from "./config-runtime.js";
import { registerContentTools } from "./content-tools.js";
import { state } from "./state.js";
import { clearResults, restoreFromSession } from "./storage.js";
import { registerWebSearchTool } from "./web-search-tool.js";

function abortPendingFetches(): void {
	for (const controller of state.pendingFetches.values()) controller.abort();
	state.pendingFetches.clear();
}

export default function initializeWebAccess(pi: ExtensionAPI): void {
	const initConfig = loadConfigForExtensionInit();
	const activityKey = initConfig.shortcuts?.activity || DEFAULT_SHORTCUTS.activity;
	const handleSessionChange = (ctx: ExtensionContext) => {
		abortPendingFetches();
		state.sessionActive = true;
		restoreFromSession(ctx);
		state.widgetUnsubscribe?.();
		state.widgetUnsubscribe = null;
		activityMonitor.clear();
		if (state.widgetVisible) {
			state.widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
			updateWidget(ctx);
		}
	};

	pi.registerShortcut(activityKey as KeyId, {
		description: "Toggle web search activity",
		handler: async (ctx) => {
			state.widgetVisible = !state.widgetVisible;
			if (state.widgetVisible) {
				state.widgetUnsubscribe = activityMonitor.onUpdate(() => updateWidget(ctx));
				updateWidget(ctx);
			} else {
				state.widgetUnsubscribe?.();
				state.widgetUnsubscribe = null;
				ctx.ui.setWidget("web-activity", undefined);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));

	pi.on("session_shutdown", () => {
		state.sessionActive = false;
		abortPendingFetches();
		clearResults();
		// Unsubscribe before clear() to avoid callback with stale ctx
		state.widgetUnsubscribe?.();
		state.widgetUnsubscribe = null;
		activityMonitor.clear();
		state.widgetVisible = false;
	});

	registerWebSearchTool(pi);
	registerContentTools(pi);
	registerCommands(pi);
}
