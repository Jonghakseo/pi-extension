import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

/**
 * Idle screensaver extension
 * Shows a full-screen overlay after 15 min of inactivity.
 * Dismissed by any keypress.
 */

const IDLE_MS = 60 * 60 * 1000; // 60 minutes
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let agentRunning = false;
type ScreensaverTui = { terminal?: { rows?: number } };
type ScreensaverTheme = { fg: (color: ThemeColor, text: string) => string; bold: (text: string) => string };

let overlayActive = false;
let askUserQuestionActive = false;
let latestCtx: ExtensionContext | null = null;
let piRef: ExtensionAPI | null = null;

// ── Timer helpers ─────────────────────────────────────────────────────────────

function clearIdleTimer(): void {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

function scheduleIdleTimer(): void {
	clearIdleTimer();
	if (agentRunning || overlayActive || askUserQuestionActive) return;
	idleTimer = setTimeout(() => {
		void showScreensaver();
	}, IDLE_MS);
}

// ── Screensaver logic ─────────────────────────────────────────────────────────

async function showScreensaver(): Promise<void> {
	if (!latestCtx?.hasUI) return;

	overlayActive = true;
	clearIdleTimer();

	// Resolve title: prefer session name, fallback to folder/branch
	const sessionName = piRef?.getSessionName() ?? "";

	let title: string;
	if (sessionName) {
		title = sessionName;
	} else {
		const folder = latestCtx.sessionManager.getCwd();
		const fallbackName = latestCtx.sessionManager.getSessionName() ?? "Pi";
		let branch = "";
		try {
			branch = execSync("git branch --show-current", {
				cwd: folder,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		} catch {}
		title = branch ? `${folder.split("/").pop()}/${branch}` : fallbackName;
	}

	await latestCtx.ui.custom(
		(tui: ScreensaverTui, theme: ScreensaverTheme, _kb: unknown, done: (v: undefined) => void) => ({
			render: (w: number) => renderScreensaver(w, (tui.terminal?.rows as number | undefined) ?? 40, title, theme),
			handleInput: (_data: string) => {
				done(undefined);
			},
			invalidate: () => {},
		}),
		{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
	);

	overlayActive = false;
	scheduleIdleTimer();
}

// ── Screensaver renderer ──────────────────────────────────────────────────────

function renderScreensaver(width: number, height: number, title: string, theme: ScreensaverTheme): string[] {
	const lines: string[] = [];

	// Border color helper
	const bc = (s: string): string => theme.fg("accent", s);

	// Top/bottom horizontal rules via DynamicBorder
	const hRule = new DynamicBorder(bc).render(width)[0] ?? bc("─".repeat(width));

	// Side border chars
	const L = bc("│");
	const R = bc("│");
	const innerWidth = width - 2;

	const emptyLine = (): string => L + " ".repeat(innerWidth) + R;

	const placeLine = (chars: string): string => {
		const vw = visibleWidth(chars);
		return L + chars + " ".repeat(Math.max(0, innerWidth - vw)) + R;
	};

	const centerLine = (text: string): string => {
		const tw = visibleWidth(text);
		const pad = Math.max(0, Math.floor((innerWidth - tw) / 2));
		return placeLine(" ".repeat(pad) + text);
	};

	// ── Title separators (no box) ───────────────────────────────
	const compact = title.trim();
	const spread = compact.length <= 24 ? compact.split("").join(" ") : compact;
	const titleText = spread || "Pi";

	const separatorWidth = Math.min(innerWidth - 4, Math.max(visibleWidth(titleText) + 8, 24));
	const separator = bc("─".repeat(Math.max(1, separatorWidth)));
	const topSeparatorLine = centerLine(separator);
	const titleLine = centerLine(theme.fg("accent", titleText) as string);
	const bottomSeparatorLine = centerLine(separator);

	// ── Layout ───────────────────────────────────────────────────
	const TITLE_BLOCK_H = 3;
	const FOOTER_H = 1;
	const innerHeight = height - 2;

	const contentH = TITLE_BLOCK_H + FOOTER_H;
	const topPad = Math.max(0, Math.floor((innerHeight - contentH) / 2) - 1);

	// ── Render ───────────────────────────────────────────────────
	// 1. Top border
	lines.push(hRule);

	// 2. Top padding
	for (let i = 0; i < topPad; i++) lines.push(emptyLine());

	// 3. Title with top/bottom separators (3 lines)
	lines.push(topSeparatorLine);
	lines.push(titleLine);
	lines.push(bottomSeparatorLine);

	// 4. Fill until footer
	while (lines.length < height - 2) lines.push(emptyLine());

	// 5. Footer hint
	if (lines.length === height - 2) {
		lines.push(centerLine(theme.fg("dim", "Press any key to dismiss") as string));
	}

	// 6. Bottom border
	while (lines.length < height - 1) lines.push(emptyLine());
	lines.push(hRule);

	return lines;
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function idleScreensaver(pi: ExtensionAPI): void {
	piRef = pi;
	pi.on("input", (event, ctx) => {
		latestCtx = ctx;
		if (event.source !== "extension") {
			scheduleIdleTimer();
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		latestCtx = ctx;
		agentRunning = true;
		clearIdleTimer();
	});

	pi.on("agent_end", (_event, ctx) => {
		latestCtx = ctx;
		agentRunning = false;
		scheduleIdleTimer();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		latestCtx = ctx;
		if (event.toolName === "AskUserQuestion") {
			askUserQuestionActive = true;
			clearIdleTimer();
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		latestCtx = ctx;
		if (event.toolName === "AskUserQuestion") {
			askUserQuestionActive = false;
			scheduleIdleTimer();
		}
	});

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		clearIdleTimer();
		overlayActive = false;
		scheduleIdleTimer();
	});

	pi.on("session_shutdown", () => {
		clearIdleTimer();
	});

	scheduleIdleTimer();
}
