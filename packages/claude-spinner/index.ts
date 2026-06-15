import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SPINNER_FRAMES = ["·", "✻", "✽", "✶", "✳", "✢"] as const;
const SPINNER_INTERVAL_MS = 120;

export default function claudeSpinner(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const ui = ctx.ui;
		ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map((frame) => ui.theme.fg("accent", frame)),
			intervalMs: SPINNER_INTERVAL_MS,
		});
	});
}
