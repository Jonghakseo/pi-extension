/** biome-ignore-all lint/suspicious/noExplicitAny: replay data is read from loosely typed session JSONL and TUI callbacks. */
/**
 * Session replay viewer — reads session JSONL files and renders an
 * interactive TUI overlay for browsing past subagent conversations.
 */

import * as fs from "node:fs";
import {
	Container,
	Key,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	DEFAULT_TURN_COUNT,
	DETAIL_LINE_PADDING,
	DETAIL_PAGE_DIVISOR,
	DETAIL_SECTION_RESERVED_ROWS,
	DETAIL_WIDTH_PADDING,
	ELLIPSIS_RESERVED_CHARS,
	FALLBACK_TERMINAL_ROWS,
	JSON_SUMMARY_MAX_CHARS,
	LIST_HEIGHT_RATIO,
	LIST_PAGE_DIVISOR,
	MAX_LIST_ROWS,
	MIN_BODY_ROWS,
	MIN_DETAIL_BODY_ROWS,
	MIN_DETAIL_WIDTH,
	MIN_INNER_WIDTH,
	MIN_LIST_ROWS,
	MIN_PAGE_SIZE,
	MIN_SEPARATOR_WIDTH,
	MIN_TASK_WIDTH,
	MIN_TERMINAL_ROWS,
	OVERLAY_HORIZONTAL_MARGIN,
	REPLAY_CONTENT_MAX_CHARS,
	RESERVED_LAYOUT_ROWS,
	TASK_WIDTH_PADDING,
	TOOL_CALL_ARGS_SUMMARY_MAX_CHARS,
	TOOL_RESULT_DETAILS_SUMMARY_MAX_CHARS,
	USAGE_EXTRA_ROWS,
} from "./constants.js";
import { formatUsageStats, truncatePlainToWidth } from "./format.js";
import type { CommandRunState, SessionReplayItem } from "./types.js";
import { formatDuration, formatDurationBetween } from "./utils/time-utils.js";

// ─── Replay Helpers ──────────────────────────────────────────────────────────

function truncateSingleLine(value: string, max: number): string {
	if (value.length <= max) return value;
	if (max <= ELLIPSIS_RESERVED_CHARS) return value.slice(0, max);
	return `${value.slice(0, max - ELLIPSIS_RESERVED_CHARS)}...`;
}

function formatReplayTime(date: Date): string {
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function parseDateSafely(raw: unknown): Date {
	if (typeof raw === "number") {
		const d = new Date(raw);
		if (!Number.isNaN(d.getTime())) return d;
	}
	if (typeof raw === "string") {
		const d = new Date(raw);
		if (!Number.isNaN(d.getTime())) return d;
	}
	return new Date();
}

function summarizeJson(value: unknown, max = JSON_SUMMARY_MAX_CHARS): string {
	if (value === undefined || value === null) return "";
	let text = "";
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (!text || text === "{}") return "";
	return truncateSingleLine(text, max);
}

function extractReplayContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			parts.push(part.text);
			continue;
		}
		if (part.type === "thinking") {
			const thinking = typeof part.thinking === "string" ? part.thinking : "";
			if (thinking.trim()) {
				parts.push(`💭 ${thinking}`);
			}
			continue;
		}
		if (part.type === "toolCall") {
			const name = typeof part.name === "string" ? part.name : "tool";
			const args = summarizeJson(part.arguments, TOOL_CALL_ARGS_SUMMARY_MAX_CHARS);
			parts.push(args ? `→ ${name} ${args}` : `→ ${name}`);
		}
	}

	return parts.join("\n");
}

/** Max characters kept per replay item content to avoid memory blowup. */
function truncateReplayContent(text: string, max = REPLAY_CONTENT_MAX_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function readSessionReplayItems(sessionFile: string): SessionReplayItem[] {
	if (!sessionFile || !fs.existsSync(sessionFile)) return [];

	let raw = "";
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch {
		return [];
	}
	if (!raw.trim()) return [];

	const items: SessionReplayItem[] = [];
	let prevTime: Date | null = null;

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry?.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		const ts = parseDateSafely(msg.timestamp ?? entry.timestamp);
		const elapsed = prevTime ? formatDurationBetween(prevTime, ts) : undefined;
		prevTime = ts;

		if (msg.role === "user") {
			const content = truncateReplayContent(extractReplayContent(msg.content).trim());
			if (!content) continue;
			items.push({ type: "user", title: "User", content, timestamp: ts, elapsed });
			continue;
		}

		if (msg.role === "assistant") {
			const content = truncateReplayContent(extractReplayContent(msg.content).trim());
			if (!content) continue;
			items.push({ type: "assistant", title: "Assistant", content, timestamp: ts, elapsed });
			continue;
		}

		if (msg.role === "toolResult") {
			const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
			let content = extractReplayContent(msg.content).trim();
			if (!content && msg.details !== undefined) {
				const detailPreview = summarizeJson(msg.details, TOOL_RESULT_DETAILS_SUMMARY_MAX_CHARS);
				if (detailPreview) content = `details: ${detailPreview}`;
			}
			if (!content) content = "(no output)";
			items.push({
				type: "tool",
				title: `Tool: ${toolName}`,
				content: truncateReplayContent(content),
				timestamp: ts,
				elapsed,
			});
		}
	}

	return items;
}

export class SubagentSessionReplayOverlay {
	private selectedIndex = 0;
	private expandedIndex: number | null = null;
	private listScrollOffset = 0;
	private detailScrollOffset = 0;
	private cachedDetailWidth = -1;
	private detailWrapCache = new Map<number, string[]>();

	constructor(
		private run: CommandRunState,
		private items: SessionReplayItem[],
		private onDone: () => void,
	) {
		this.selectedIndex = Math.max(0, items.length - 1);
	}

	private getTerminalRows(): number {
		return Math.max(MIN_TERMINAL_ROWS, (process.stdout as any).rows || FALLBACK_TERMINAL_ROWS);
	}

	private getViewportSizes(hasDetail: boolean, hasUsage: boolean): { list: number; detail: number } {
		const rows = this.getTerminalRows();
		const reserved = RESERVED_LAYOUT_ROWS + (hasUsage ? USAGE_EXTRA_ROWS : 0); // top/header/task/sep/footer/help/bottom
		const body = Math.max(MIN_BODY_ROWS, rows - reserved);
		if (!hasDetail) return { list: Math.max(MIN_LIST_ROWS, body), detail: 0 };

		const detailBody = Math.max(MIN_DETAIL_BODY_ROWS, body - DETAIL_SECTION_RESERVED_ROWS); // detail separator + detail header
		const list = Math.max(MIN_LIST_ROWS, Math.min(MAX_LIST_ROWS, Math.floor(detailBody * LIST_HEIGHT_RATIO)));
		const detail = Math.max(MIN_LIST_ROWS, detailBody - list);
		return { list, detail };
	}

	private onSelectionMoved(): void {
		if (this.expandedIndex !== null) {
			this.expandedIndex = this.selectedIndex;
			this.detailScrollOffset = 0;
		}
	}

	private ensureListVisible(listViewport: number): void {
		if (this.selectedIndex < this.listScrollOffset) {
			this.listScrollOffset = this.selectedIndex;
		} else if (this.selectedIndex >= this.listScrollOffset + listViewport) {
			this.listScrollOffset = this.selectedIndex - listViewport + 1;
		}
		const maxOffset = Math.max(0, this.items.length - listViewport);
		if (this.listScrollOffset > maxOffset) this.listScrollOffset = maxOffset;
	}

	private getDetailLines(itemIndex: number, contentWidth: number): string[] {
		if (this.cachedDetailWidth !== contentWidth) {
			this.cachedDetailWidth = contentWidth;
			this.detailWrapCache.clear();
		}
		const cached = this.detailWrapCache.get(itemIndex);
		if (cached) return cached;

		const raw = this.items[itemIndex]?.content ?? "";
		const normalized = raw.replace(/\r/g, "");
		const lines: string[] = [];
		for (const sourceLine of normalized.split("\n")) {
			if (!sourceLine) {
				lines.push("");
				continue;
			}
			const targetWidth = Math.max(MIN_DETAIL_WIDTH, contentWidth);
			const wrapped = wrapTextWithAnsi(sourceLine, targetWidth);
			if (wrapped.length === 0) {
				lines.push(sourceLine);
				continue;
			}
			if (wrapped.length === 1 && wrapped[0].length > targetWidth) {
				for (let i = 0; i < sourceLine.length; i += targetWidth) {
					lines.push(sourceLine.slice(i, i + targetWidth));
				}
				continue;
			}
			lines.push(...wrapped);
		}
		if (lines.length === 0) lines.push("(empty)");

		this.detailWrapCache.set(itemIndex, lines);
		return lines;
	}

	private scrollDetail(delta: number): void {
		if (this.expandedIndex === null) return;
		this.detailScrollOffset = Math.max(0, this.detailScrollOffset + delta);
	}

	handleInput(data: string, tui: any): void {
		const listPage = Math.max(MIN_PAGE_SIZE, Math.floor(this.getTerminalRows() / LIST_PAGE_DIVISOR));
		const detailPage = Math.max(MIN_LIST_ROWS, Math.floor(this.getTerminalRows() / DETAIL_PAGE_DIVISOR));
		const hasDetailOpen = this.expandedIndex !== null;

		if ((matchesKey(data, Key.left) || data === "h") && hasDetailOpen) {
			this.scrollDetail(-1);
		} else if ((matchesKey(data, Key.right) || data === "l") && hasDetailOpen) {
			this.scrollDetail(1);
		} else if (matchesKey(data, Key.ctrl("u")) && hasDetailOpen) {
			this.scrollDetail(-detailPage);
		} else if (matchesKey(data, Key.ctrl("d")) && hasDetailOpen) {
			this.scrollDetail(detailPage);
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.onSelectionMoved();
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
			this.onSelectionMoved();
		} else if (data === "\x1b[5~" /* PageUp */) {
			this.selectedIndex = Math.max(0, this.selectedIndex - listPage);
			this.onSelectionMoved();
		} else if (data === "\x1b[6~" /* PageDown */) {
			this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + listPage);
			this.onSelectionMoved();
		} else if (data === "g") {
			this.selectedIndex = 0;
			this.onSelectionMoved();
		} else if (data === "G") {
			this.selectedIndex = Math.max(0, this.items.length - 1);
			this.onSelectionMoved();
		} else if (matchesKey(data, Key.enter)) {
			if (this.expandedIndex === this.selectedIndex) {
				this.expandedIndex = null;
				this.detailScrollOffset = 0;
			} else {
				this.expandedIndex = this.selectedIndex;
				this.detailScrollOffset = 0;
			}
		} else if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.onDone();
			return;
		}
		tui.requestRender();
	}

	render(width: number, _height: number, theme: any): string[] {
		const container = new Container();
		const pad = "  ";
		const innerWidth = Math.max(MIN_INNER_WIDTH, width - OVERLAY_HORIZONTAL_MARGIN);
		const elapsedLabel = formatDuration(this.run.elapsedMs);
		const usageLine = this.run.usage ? formatUsageStats(this.run.usage, this.run.model) : "";
		const task = this.run.task
			.replace(/\s*\n+\s*/g, " ")
			.replace(/\s{2,}/g, " ")
			.trim();
		const hasDetailOpen = this.expandedIndex !== null;
		const { list: listViewport, detail: detailViewport } = this.getViewportSizes(hasDetailOpen, Boolean(usageLine));

		this.ensureListVisible(listViewport);

		const contextLabel = this.run.contextMode === "main" ? "main" : "isolated";
		const formatFooterLine = (helpText: string, rangeText: string) => {
			const rangeWidth = visibleWidth(rangeText);
			const gap = rangeWidth > 0 ? 2 : 0;
			const helpWidth = Math.max(0, innerWidth - rangeWidth - gap);
			const help = truncatePlainToWidth(helpText, helpWidth);
			return `${theme.fg("dim", help)}${" ".repeat(gap)}${theme.fg("accent", rangeText)}`;
		};

		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				pad +
					theme.fg("toolTitle", theme.bold(`#${this.run.id} ${this.run.agent}`)) +
					theme.fg(
						"dim",
						`  [${this.run.status}] ctx:${contextLabel} turn:${this.run.turnCount ?? DEFAULT_TURN_COUNT}  ${elapsedLabel}  tools:${this.run.toolCalls}`,
					),
				0,
				0,
			),
		);
		container.addChild(
			new Text(
				pad + theme.fg("dim", truncateSingleLine(task, Math.max(MIN_TASK_WIDTH, innerWidth - TASK_WIDTH_PADDING))),
				0,
				0,
			),
		);
		if (usageLine) container.addChild(new Text(pad + theme.fg("dim", usageLine), 0, 0));
		container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(MIN_SEPARATOR_WIDTH, innerWidth))), 0, 0));

		for (let row = 0; row < listViewport; row++) {
			const idx = this.listScrollOffset + row;
			const item = this.items[idx];
			if (!item) {
				container.addChild(new Text("", 0, 0));
				continue;
			}

			const isSelected = idx === this.selectedIndex;
			let icon = "○";
			let color: "success" | "accent" | "warning" | "dim" = "dim";
			if (item.type === "user") {
				icon = "👤";
				color = "success";
			} else if (item.type === "assistant") {
				icon = "🤖";
				color = "accent";
			} else if (item.type === "tool") {
				icon = "🛠️";
				color = "warning";
			}

			const timeLabel = `[${formatReplayTime(item.timestamp)}${item.elapsed ? ` +${item.elapsed}` : ""}]`;
			const marker = isSelected ? "▸" : " ";
			const preview =
				item.content
					.replace(/\s*\n+\s*/g, " ")
					.replace(/\s{2,}/g, " ")
					.trim() || "(empty)";
			const fixed = `${marker} ${theme.fg(color, icon)} ${theme.bold(item.title)} ${theme.fg("dim", timeLabel)} `;
			const previewWidth = Math.max(0, innerWidth - visibleWidth(fixed));
			let line = `${fixed}${theme.fg("muted", truncatePlainToWidth(preview, previewWidth))}`;
			line = truncateToWidth(line, innerWidth, "");
			if (isSelected) line = theme.bg("selectedBg", line);
			container.addChild(new Text(pad + line, 0, 0));
		}

		if (hasDetailOpen) {
			container.addChild(
				new Text(pad + theme.fg("muted", "─".repeat(Math.max(MIN_SEPARATOR_WIDTH, innerWidth))), 0, 0),
			);
			const detailIndex = this.expandedIndex ?? this.selectedIndex;
			const detailItem = this.items[detailIndex];
			const detailLines = this.getDetailLines(
				detailIndex,
				Math.max(MIN_DETAIL_WIDTH, innerWidth - DETAIL_WIDTH_PADDING),
			);
			const maxDetailOffset = Math.max(0, detailLines.length - detailViewport);
			if (this.detailScrollOffset > maxDetailOffset) this.detailScrollOffset = maxDetailOffset;
			const start = this.detailScrollOffset;
			const end = Math.min(detailLines.length, start + detailViewport);
			const range =
				detailLines.length === 0 ? "0-0/0" : `${start + 1}-${Math.max(start + 1, end)}/${detailLines.length}`;
			container.addChild(
				new Text(
					pad +
						theme.fg("accent", theme.bold(`Detail: ${detailItem?.title ?? "entry"}`)) +
						theme.fg("dim", `  (${range})`),
					0,
					0,
				),
			);

			for (let i = start; i < end; i++) {
				const line = detailLines[i] ?? "";
				container.addChild(
					new Text(
						pad +
							theme.fg(
								"toolOutput",
								`  ${truncatePlainToWidth(line, Math.max(MIN_DETAIL_WIDTH, innerWidth - DETAIL_LINE_PADDING))}`,
							),
						0,
						0,
					),
				);
			}
		}

		container.addChild(new Text(pad + theme.fg("muted", "─".repeat(Math.max(MIN_SEPARATOR_WIDTH, innerWidth))), 0, 0));
		const listStart = this.items.length === 0 ? 0 : this.listScrollOffset + 1;
		const listEnd = Math.min(this.items.length, this.listScrollOffset + listViewport);
		const listRange = `${listStart}-${listEnd}/${this.items.length}`;
		const helpText = hasDetailOpen
			? "↑↓/jk list · Enter close detail · ←/→ or h/l detail scroll · Ctrl+u/d detail page · PgUp/Dn list · Esc close"
			: "↑↓/jk navigate · Enter open detail · PgUp/Dn page · g/G top/end · Esc close";
		container.addChild(new Text(pad + formatFooterLine(helpText, listRange), 0, 0));
		container.addChild(new Spacer(1));

		return container.render(width);
	}
}
