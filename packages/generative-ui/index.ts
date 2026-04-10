import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ThemeColor } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { AVAILABLE_MODULES, getGuidelines } from "./guidelines.js";
import { escapeJS, shellHTML, wrapHTML } from "./html-utils.js";

interface WidgetHistoryEntry {
	title: string;
	code: string;
	width: number;
	height: number;
	isSVG: boolean;
	timestamp: number;
}

interface GlimpseWindow {
	on(event: "ready" | "closed", handler: () => void): void;
	send(script: string): void;
	setHTML(html: string): void;
}

interface GlimpseModule {
	open(html: string, options: { width: number; height: number; title: string; floating?: boolean }): GlimpseWindow;
}

export function shouldApplyFinalStreamingHTML(finalHTML: string | null, finalHTMLApplied: boolean): boolean {
	return Boolean(finalHTML) && !finalHTMLApplied;
}

interface StreamingWidget {
	contentIndex: number;
	window: GlimpseWindow | null;
	lastHTML: string;
	updateTimer: ReturnType<typeof setTimeout> | null;
	ready: boolean;
	finalHTML: string | null;
	finalIsSVG: boolean;
	finalHTMLApplied: boolean;
}

function createStreamingWidget(contentIndex: number): StreamingWidget {
	return {
		contentIndex,
		window: null,
		lastHTML: "",
		updateTimer: null,
		ready: false,
		finalHTML: null,
		finalIsSVG: false,
		finalHTMLApplied: false,
	};
}

function extractStreamingWidgetCode(
	block: { type?: string; arguments?: Record<string, unknown> } | undefined,
): string | undefined {
	const widgetCode = block?.type === "toolCall" ? block.arguments?.widget_code : undefined;
	return typeof widgetCode === "string" ? widgetCode : undefined;
}

export default function (pi: ExtensionAPI) {
	let activeWindows: GlimpseWindow[] = [];
	let glimpseModule: GlimpseModule | null = null;
	const widgetHistory: WidgetHistoryEntry[] = [];
	const require = createRequire(import.meta.url);
	const glimpsePath = pathToFileURL(require.resolve("glimpseui")).href;

	// Lazy-load glimpse module using package resolution
	async function getGlimpse(): Promise<GlimpseModule> {
		if (!glimpseModule) {
			glimpseModule = (await import(glimpsePath)) as unknown as GlimpseModule;
		}
		return glimpseModule;
	}

	// ── Streaming state ─────────────────────────────────────────────────────

	let streaming: StreamingWidget | null = null;

	// ── message_update: intercept streaming tool calls ────────────────────

	function sendStreamingHTML(currentStreaming: StreamingWidget): void {
		if (currentStreaming.finalHTMLApplied || !currentStreaming.lastHTML) return;
		const escaped = escapeJS(currentStreaming.lastHTML);
		currentStreaming.window?.send(`window._setContent('${escaped}')`);
	}

	function applyFinalStreamingHTML(currentStreaming: StreamingWidget): boolean {
		const finalHTML = currentStreaming.finalHTML;
		if (!finalHTML || !shouldApplyFinalStreamingHTML(finalHTML, currentStreaming.finalHTMLApplied)) {
			return false;
		}
		currentStreaming.finalHTMLApplied = true;
		currentStreaming.window?.setHTML(wrapHTML(finalHTML, currentStreaming.finalIsSVG));
		return true;
	}

	function attachStreamingWindowReadyHandler(currentStreaming: StreamingWidget): void {
		currentStreaming.window?.on("ready", () => {
			currentStreaming.ready = true;
			if (!applyFinalStreamingHTML(currentStreaming)) {
				sendStreamingHTML(currentStreaming);
			}
		});
	}

	async function ensureStreamingWindow(
		currentStreaming: StreamingWidget,
		block: { type?: string; arguments?: Record<string, unknown> } | undefined,
	): Promise<void> {
		if (currentStreaming.window) return;
		const args = block?.type === "toolCall" ? (block.arguments ?? {}) : {};
		const title = String(args.title ?? "Widget").replace(/_/g, " ");
		const width = typeof args.width === "number" ? args.width : 800;
		const height = typeof args.height === "number" ? args.height : 600;
		const { open } = await getGlimpse();
		currentStreaming.window = open(shellHTML(), { width, height, title });
		activeWindows.push(currentStreaming.window);
		attachStreamingWindowReadyHandler(currentStreaming);
	}

	function scheduleStreamingUpdate(
		currentStreaming: StreamingWidget,
		block: { type?: string; arguments?: Record<string, unknown> } | undefined,
	): void {
		if (currentStreaming.updateTimer) return;
		currentStreaming.updateTimer = setTimeout(async () => {
			currentStreaming.updateTimer = null;
			try {
				await ensureStreamingWindow(currentStreaming, block);
				if (currentStreaming.ready) {
					sendStreamingHTML(currentStreaming);
				}
			} catch {}
		}, 150);
	}

	function finalizeStreamingWidget(widgetCode: string | undefined): void {
		if (!streaming) return;
		if (streaming.updateTimer) {
			clearTimeout(streaming.updateTimer);
			streaming.updateTimer = null;
		}
		if (!widgetCode) return;
		streaming.finalHTML = widgetCode;
		streaming.finalIsSVG = widgetCode.trimStart().startsWith("<svg");
	}

	pi.on("message_update", async (event) => {
		const raw = event.assistantMessageEvent;
		if (raw.type === "toolcall_start") {
			const block = raw.partial.content[raw.contentIndex];
			if (block?.type === "toolCall" && block?.name === "show_widget") {
				streaming = createStreamingWidget(raw.contentIndex);
			}
			return;
		}
		if (raw.type === "toolcall_delta" && streaming && raw.contentIndex === streaming.contentIndex) {
			const block = raw.partial.content[raw.contentIndex];
			const html = extractStreamingWidgetCode(block);
			if (!html || html.length < 20 || html === streaming.lastHTML) return;
			streaming.lastHTML = html;
			scheduleStreamingUpdate(streaming, block);
			return;
		}
		if (raw.type === "toolcall_end" && streaming && raw.contentIndex === streaming.contentIndex) {
			finalizeStreamingWidget(extractStreamingWidgetCode(raw.toolCall));
		}
	});

	// ── read_me tool ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "visualize_read_me",
		label: "Read Guidelines",
		description:
			"Returns design guidelines for show_widget (CSS patterns, colors, typography, layout rules, examples). " +
			"Call once before your first show_widget call. Do NOT mention this call to the user — it is an internal setup step.",
		promptSnippet: "Load design guidelines before creating widgets. Call silently before first show_widget use.",
		promptGuidelines: [
			"Call visualize_read_me once before your first show_widget call to load design guidelines.",
			"Do NOT mention the read_me call to the user — call it silently, then proceed directly to building the widget.",
			"Pick the modules that match your use case: interactive, chart, mockup, art, diagram.",
		],
		parameters: Type.Object({
			modules: Type.Array(StringEnum(AVAILABLE_MODULES as readonly string[]), {
				description: "Which module(s) to load. Pick all that fit.",
			}),
		}),

		async execute(_toolCallId, params) {
			const content = getGuidelines(params.modules);
			return {
				content: [{ type: "text" as const, text: content }],
				details: { modules: params.modules },
			};
		},

		renderCall(args, theme) {
			const mods = (args.modules ?? []).join(", ");
			return new Text(theme.fg("toolTitle", theme.bold("read_me ")) + theme.fg("muted", mods), 0, 0);
		},

		renderResult(_result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Loading guidelines..."), 0, 0);
			return new Text(theme.fg("dim", "Guidelines loaded"), 0, 0);
		},
	});

	// ── show_widget tool ──────────────────────────────────────────────────────

	pi.registerTool({
		name: "show_widget",
		label: "Show Widget",
		description:
			"Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — in a native macOS window. " +
			"Use for flowcharts, dashboards, forms, calculators, data tables, games, illustrations, or any visual content. " +
			"The HTML is rendered in a native WKWebView with full CSS/JS support including Canvas and CDN libraries. " +
			"IMPORTANT: Call visualize_read_me once before your first show_widget call.",
		promptSnippet:
			"Render interactive HTML/SVG widgets in a native macOS window (WKWebView). Supports full CSS, JS, Canvas, Chart.js.",
		promptGuidelines: [
			"Use show_widget when the user asks for visual content: charts, diagrams, interactive explainers, UI mockups, art.",
			"Always call visualize_read_me first to load design guidelines, then set i_have_seen_read_me: true.",
			"The widget opens in a native macOS window — it has full browser capabilities (Canvas, JS, CDN libraries).",
			"Structure HTML as fragments: no DOCTYPE/<html>/<head>/<body>. Style first, then HTML, then scripts.",
			"Keep widgets focused and appropriately sized. Default is 800x600 but adjust to fit content.",
			"For interactive explainers: sliders, live calculations, Chart.js charts.",
			"For SVG: start code with <svg> tag, it will be auto-detected.",
			"Be concise in your responses",
		],
		parameters: Type.Object({
			i_have_seen_read_me: Type.Boolean({
				description: "Confirm you have already called visualize_read_me in this conversation.",
			}),
			title: Type.String({
				description: "Short snake_case identifier for this widget (used as window title).",
			}),
			widget_code: Type.String({
				description:
					"HTML or SVG code to render. For SVG: raw SVG starting with <svg>. " +
					"For HTML: raw content fragment, no DOCTYPE/<html>/<head>/<body>.",
			}),
			width: Type.Optional(Type.Number({ description: "Window width in pixels. Default: 800." })),
			height: Type.Optional(Type.Number({ description: "Window height in pixels. Default: 600." })),
			floating: Type.Optional(Type.Boolean({ description: "Keep window always on top. Default: false." })),
		}),

		async execute(_toolCallId, params, _signal) {
			if (!params.i_have_seen_read_me) {
				throw new Error(
					"You must call visualize_read_me before show_widget. Set i_have_seen_read_me: true after doing so.",
				);
			}

			const code = params.widget_code;
			const isSVG = code.trimStart().startsWith("<svg");
			const title = params.title.replace(/_/g, " ");
			const width = params.width ?? 800;
			const height = params.height ?? 600;

			// Check if we already have a streaming window from message_update
			let win: GlimpseWindow;
			const existingWindow = streaming?.window;

			if (existingWindow) {
				const currentStreaming = streaming;
				if (!currentStreaming) {
					throw new Error("Missing streaming state for existing widget window.");
				}
				win = existingWindow;
				currentStreaming.finalHTML = code;
				currentStreaming.finalIsSVG = isSVG;
				// Replace the streaming shell with the final document so browser-native script execution runs.
				if (shouldApplyFinalStreamingHTML(currentStreaming.finalHTML, currentStreaming.finalHTMLApplied)) {
					currentStreaming.finalHTMLApplied = true;
					win.setHTML(wrapHTML(code, isSVG));
				}
				streaming = null;
			} else {
				// No streaming window — open fresh (fallback for non-streaming providers)
				const { open } = await getGlimpse();
				win = open(wrapHTML(code, isSVG), {
					width,
					height,
					title,
					floating: params.floating ?? false,
				});
				activeWindows.push(win);
			}

			// Save to history for /widgets gallery
			widgetHistory.push({ title, code, width, height, isSVG, timestamp: Date.now() });

			// Clean up activeWindows when the window is closed
			win.on("closed", () => {
				activeWindows = activeWindows.filter((w) => w !== win);
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Widget "${title}" rendered and shown to the user (${width}×${height}).`,
					},
				],
				details: {
					title: params.title,
					width,
					height,
					isSVG,
				},
			};
		},

		renderCall(args, theme) {
			const title = (args.title ?? "widget").replace(/_/g, " ");
			const size = args.width && args.height ? ` ${args.width}×${args.height}` : "";
			let text = theme.fg("toolTitle", theme.bold("show_widget "));
			text += theme.fg("accent", title);
			if (size) text += theme.fg("dim", size);

			const code = typeof args.widget_code === "string" ? args.widget_code : "";
			if (code.length > 0) {
				const lines = code.split("\n");
				const lineCount = lines.length;
				const bytes = Buffer.byteLength(code, "utf8");
				const isSVG = code.trimStart().startsWith("<svg");
				const tag = isSVG ? "SVG" : "HTML";
				text += theme.fg("muted", ` (${tag} ${lineCount} lines • ${bytes} bytes)`);

				// Show last 4 lines as preview (sanitized + truncated)
				const MAX_LINE_WIDTH = 100;
				const previewLines = lines.slice(-4);
				const hidden = lines.length - previewLines.length;
				if (hidden > 0) {
					text += `\n${theme.fg("muted", `… (${hidden} earlier lines)`)}`;
				}
				for (const line of previewLines) {
					// Strip control chars / ANSI sequences, replace tabs, truncate
					let safe = line
						.replace(/\t/g, "    ")
						// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization
						.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
						// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI CSI sequences
						.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
						// biome-ignore lint/suspicious/noControlCharactersInRegex: strip OSC sequences
						.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
					if (safe.length > MAX_LINE_WIDTH) {
						safe = `${safe.slice(0, MAX_LINE_WIDTH)}…`;
					}
					text += `\n${theme.fg("dim", safe)}`;
				}
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "⟳ Widget rendering..."), 0, 0);
			}

			const details = result.details ?? {};
			const title = (details.title ?? "widget").replace(/_/g, " ");
			let text = theme.fg("success", "✓ ") + theme.fg("accent", title);
			text += theme.fg("dim", ` ${details.width ?? 800}×${details.height ?? 600}`);
			if (details.isSVG) text += theme.fg("dim", " (SVG)");

			return new Text(text, 0, 0);
		},
	});

	// ── /widgets command — gallery of past widgets ──────────────────────────

	pi.registerCommand("widgets", {
		description: "Browse and reopen past widgets",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			if (widgetHistory.length === 0) {
				ctx.ui.notify("No widgets yet — use show_widget first", "info");
				return;
			}

			await ctx.ui.custom(
				(tui, theme, _kb, done) => {
					const ui = new WidgetGalleryUI(
						widgetHistory,
						async (entry) => {
							const { open } = await getGlimpse();
							const win = open(wrapHTML(entry.code, entry.isSVG), {
								width: entry.width,
								height: entry.height,
								title: entry.title,
							});
							activeWindows.push(win);
							win.on("closed", () => {
								activeWindows = activeWindows.filter((w) => w !== win);
							});
							if (ctx.hasUI) ctx.ui.notify(`Reopened "${entry.title}"`, "info");
							tui.requestRender();
						},
						() => done(undefined),
					);

					return {
						render: (w) => ui.render(w, tui.terminal.rows ?? 40, theme),
						handleInput: (data) => ui.handleInput(data, tui),
						invalidate: () => {},
					};
				},
				{
					overlay: true,
					overlayOptions: { width: "70%", maxHeight: "70%", anchor: "center" },
				},
			);
		},
	});
}

// ── Widget Gallery Overlay ──────────────────────────────────────────────────

type OverlayTui = { requestRender: () => void };
type OverlayTheme = { fg: (color: ThemeColor, text: string) => string; bold: (text: string) => string };

class WidgetGalleryUI {
	private selectedIndex = 0;
	private reopenedSet = new Set<number>();

	constructor(
		private history: WidgetHistoryEntry[],
		private onReopen: (entry: WidgetHistoryEntry) => void,
		private onDone: () => void,
	) {
		// Start at newest
		this.selectedIndex = history.length - 1;
	}

	handleInput(data: string, tui: OverlayTui): void {
		if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(this.history.length - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, Key.enter)) {
			const entry = this.history[this.selectedIndex];
			if (entry) {
				this.reopenedSet.add(this.selectedIndex);
				this.onReopen(entry);
			}
		} else if (data === "a") {
			for (let i = 0; i < this.history.length; i++) {
				this.reopenedSet.add(i);
				this.onReopen(this.history[i]);
			}
		} else if (matchesKey(data, Key.escape) || data === "q") {
			this.onDone();
			return;
		}
		tui.requestRender();
	}

	render(width: number, height: number, theme: OverlayTheme): string[] {
		const lines: string[] = [];

		// Header
		lines.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));
		lines.push(
			`${theme.fg("accent", theme.bold("  WIDGETS"))} ${theme.fg("dim", "|")} ${theme.fg("muted", `${this.history.length} widget(s) this session`)}`,
		);
		lines.push("");

		// List area
		const listHeight = height - 7; // header(3) + footer(4)
		const total = this.history.length;

		// Compute visible window (scroll so selected is always visible)
		let scrollTop = 0;
		if (total > listHeight) {
			scrollTop = Math.min(Math.max(0, this.selectedIndex - Math.floor(listHeight / 2)), total - listHeight);
		}

		for (let vi = 0; vi < listHeight; vi++) {
			const idx = scrollTop + vi;
			if (idx >= total) {
				lines.push("");
				continue;
			}

			const entry = this.history[idx];
			const isSelected = idx === this.selectedIndex;
			const wasReopened = this.reopenedSet.has(idx);

			const cursor = isSelected ? theme.fg("accent", " ❯ ") : "   ";
			const num = theme.fg("dim", `${String(idx + 1).padStart(2)}.`);
			const tag = entry.isSVG ? theme.fg("warning", "SVG") : theme.fg("accent", "HTM");
			const title = isSelected ? theme.fg("accent", theme.bold(entry.title)) : theme.fg("muted", entry.title);
			const size = theme.fg("dim", `${entry.width}×${entry.height}`);
			const time = theme.fg("dim", formatTime(entry.timestamp));
			const reopenBadge = wasReopened ? theme.fg("success", " ✓") : "";

			const line = `${cursor}${num} ${tag} ${title} ${size} ${time}${reopenBadge}`;
			lines.push(truncateToWidth(line, width - 2));
		}

		// Footer
		lines.push("");
		lines.push(theme.fg("dim", "  ↑/↓ Select  •  Enter Reopen  •  a All  •  Esc Close"));
		lines.push(...new DynamicBorder((s: string) => theme.fg("accent", s)).render(width));

		return lines;
	}
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}
