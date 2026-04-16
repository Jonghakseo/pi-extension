/**
 * /memory overlay UI components — Markdown-based memory system.
 * Displays entries as [scope] topic / title.
 */

import { DynamicBorder, getMarkdownTheme, type Theme } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type Focusable,
	fuzzyMatch,
	getKeybindings,
	Input,
	Key,
	Markdown,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { SearchResult } from "./storage.ts";
import type { MemoryScope } from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type MemoryMenuAction = "view" | "viewTopic" | "delete" | "copyContent";
export type ScopeFilter = "all" | "user" | "project";

// ── Helpers ──────────────────────────────────────────────────────────────────

function scopeBadge(theme: Theme, scope: MemoryScope): string {
	return scope === "user" ? theme.fg("accent", "[user]") : theme.fg("success", "[project]");
}

function buildSearchText(entry: SearchResult): string {
	return [entry.scope, entry.topic, entry.title, entry.content, entry.projectId ?? ""].join(" ").toLowerCase();
}

function filterEntries(entries: SearchResult[], query: string, scopeFilter: ScopeFilter): SearchResult[] {
	let filtered = entries;
	if (scopeFilter !== "all") {
		filtered = filtered.filter((e) => e.scope === scopeFilter);
	}
	const trimmed = query.trim();
	if (!trimmed) return filtered;

	const tokens = trimmed
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean);
	if (!tokens.length) return filtered;

	const scored: Array<{ entry: SearchResult; score: number }> = [];
	for (const entry of filtered) {
		const text = buildSearchText(entry);
		let totalScore = 0;
		let matched = true;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) {
				matched = false;
				break;
			}
			totalScore += result.score;
		}
		if (matched) scored.push({ entry, score: totalScore });
	}
	return scored.sort((a, b) => a.score - b.score).map((s) => s.entry);
}

// ── Memory Selector Component ────────────────────────────────────────────────

export class MemorySelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private allEntries: SearchResult[];
	private filteredEntries: SearchResult[];
	private selectedIndex = 0;
	private scopeFilter: ScopeFilter = "all";
	private onSelectCallback: (entry: SearchResult) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private theme: Theme;
	private headerText: Text;
	private scopeText: Text;
	private hintText: Text;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		entries: SearchResult[],
		onSelect: (entry: SearchResult) => void,
		onCancel: () => void,
		initialSearch?: string,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.allEntries = entries;
		this.filteredEntries = entries;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);

		this.scopeText = new Text("", 1, 0);
		this.addChild(this.scopeText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearch) this.searchInput.setValue(initialSearch);
		this.searchInput.onSubmit = () => {
			const selected = this.filteredEntries[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));

		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateHeader();
		this.updateScopeDisplay();
		this.updateHints();
		this.applyFilter();
	}

	setEntries(entries: SearchResult[]): void {
		this.allEntries = entries;
		this.updateHeader();
		this.applyFilter();
		this.tui.requestRender();
	}

	private updateHeader(): void {
		const count = this.allEntries.length;
		const topics = new Set(this.allEntries.map((e) => e.topic)).size;
		const title = `Memories (${count} entries, ${topics} topics)`;
		this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
	}

	private updateScopeDisplay(): void {
		const labels: Record<ScopeFilter, string> = {
			all: "📋 All",
			user: "🌐 User only",
			project: "📁 Project only",
		};
		this.scopeText.setText(
			this.theme.fg("muted", `Filter: ${labels[this.scopeFilter]}`) + this.theme.fg("dim", "  (Tab to cycle)"),
		);
	}

	private updateHints(): void {
		this.hintText.setText(this.theme.fg("dim", "Type to search • ↑↓ select • Enter actions • Tab scope • Esc close"));
	}

	private applyFilter(): void {
		this.filteredEntries = filterEntries(this.allEntries, this.searchInput.getValue(), this.scopeFilter);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredEntries.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredEntries.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching memories"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredEntries.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredEntries.length);

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.filteredEntries[i];
			if (!entry) continue;
			const isSelected = i === this.selectedIndex;

			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const badge = scopeBadge(this.theme, entry.scope);
			const topicLabel = this.theme.fg("muted", `${entry.topic}/`);
			const titleColor = isSelected ? "accent" : "text";
			const titleText = this.theme.fg(titleColor, entry.title || "(untitled)");

			this.listContainer.addChild(new Text(`${prefix}${badge} ${topicLabel}${titleText}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredEntries.length) {
			const scrollInfo = this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredEntries.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}
	}

	private cycleScope(): void {
		const order: ScopeFilter[] = ["all", "user", "project"];
		const idx = order.indexOf(this.scopeFilter);
		this.scopeFilter = order[(idx + 1) % order.length];
		this.updateScopeDisplay();
		this.applyFilter();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (!this.filteredEntries.length) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredEntries.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (!this.filteredEntries.length) return;
			this.selectedIndex = this.selectedIndex === this.filteredEntries.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredEntries[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		if (matchesKey(keyData, Key.tab)) {
			this.cycleScope();
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateScopeDisplay();
		this.updateHints();
		this.updateList();
	}
}

// ── Memory Action Menu Component ─────────────────────────────────────────────

export class MemoryActionMenuComponent extends Container {
	private selectList: SelectList;

	constructor(theme: Theme, entry: SearchResult, onSelect: (action: MemoryMenuAction) => void, onCancel: () => void) {
		super();

		const options: SelectItem[] = [
			{ value: "view", label: "View entry", description: "View this memory entry" },
			{ value: "viewTopic", label: "View full topic", description: `View entire ${entry.topic}.md file` },
			{ value: "copyContent", label: "Copy content", description: "Copy to clipboard" },
			{ value: "delete", label: "🗑️ Delete", description: "Permanently delete this entry" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(
			new Text(
				`${theme.fg("accent", theme.bold("Actions"))} ${scopeBadge(theme, entry.scope)} ` +
					`${theme.fg("muted", `${entry.topic}/`)}${theme.fg("text", `"${entry.title}"`)}`,
			),
		);

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		this.selectList.onSelect = (item) => onSelect(item.value as MemoryMenuAction);
		this.selectList.onCancel = () => onCancel();

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter confirm • Esc back")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}

// ── Memory Detail Overlay ────────────────────────────────────────────────────

export class MemoryDetailOverlayComponent {
	private tui: TUI;
	private theme: Theme;
	private entry: SearchResult;
	private markdown: Markdown;
	private scrollOffset = 0;
	private viewHeight = 0;
	private totalLines = 0;
	private onClose: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(tui: TUI, theme: Theme, entry: SearchResult, onClose: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.entry = entry;
		this.onClose = onClose;
		this.markdown = new Markdown(this.buildContent(), 1, 0, getMarkdownTheme());
	}

	private buildContent(): string {
		const { title, content } = this.entry;
		return `**${title}**\n\n${content || "_No content._"}`;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.scroll(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.scroll(1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageUp")) {
			this.scroll(-this.viewHeight || -1);
			return;
		}
		if (kb.matches(keyData, "tui.select.pageDown")) {
			this.scroll(this.viewHeight || 1);
			return;
		}
	}

	render(width: number): string[] {
		const maxH = Math.max(10, Math.floor((this.tui.terminal.rows || 24) * 0.8));
		const headerLines = 3;
		const footerLines = 2;
		const borderLines = 2;
		const innerW = Math.max(10, width - 2);
		const contentH = Math.max(1, maxH - headerLines - footerLines - borderLines);

		const mdLines = this.markdown.render(innerW);
		this.totalLines = mdLines.length;
		this.viewHeight = contentH;
		const maxScroll = Math.max(0, this.totalLines - contentH);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

		const visible = mdLines.slice(this.scrollOffset, this.scrollOffset + contentH);
		const lines: string[] = [];

		// Header
		const e = this.entry;
		const titleLine = ` ${e.title} `;
		const tw = visibleWidth(titleLine);
		const leftW = Math.max(0, Math.floor((innerW - tw) / 2));
		const rightW = Math.max(0, innerW - tw - leftW);
		lines.push(
			this.theme.fg("borderMuted", "─".repeat(leftW)) +
				this.theme.fg("accent", titleLine) +
				this.theme.fg("borderMuted", "─".repeat(rightW)),
		);
		lines.push(
			`${scopeBadge(this.theme, e.scope)} ${this.theme.fg("muted", `${e.topic}.md`)}${e.projectId ? this.theme.fg("dim", ` • ${e.projectId}`) : ""}`,
		);
		lines.push("");

		// Content
		for (const l of visible) lines.push(truncateToWidth(l, innerW));
		while (lines.length < headerLines + contentH) lines.push("");

		// Footer
		let footer = this.theme.fg("dim", "esc back • ↑↓ scroll");
		if (this.totalLines > this.viewHeight) {
			const start = Math.min(this.totalLines, this.scrollOffset + 1);
			const end = Math.min(this.totalLines, this.scrollOffset + this.viewHeight);
			footer += this.theme.fg("dim", ` ${start}-${end}/${this.totalLines}`);
		}
		lines.push("");
		lines.push(footer);

		// Frame
		const bc = (t: string) => this.theme.fg("borderMuted", t);
		const top = bc(`┌${"─".repeat(innerW)}┐`);
		const bottom = bc(`└${"─".repeat(innerW)}┘`);
		const framed = lines.map((l) => {
			const tr = truncateToWidth(l, innerW);
			const pad = Math.max(0, innerW - visibleWidth(tr));
			return `${bc("│")}${tr}${" ".repeat(pad)}${bc("│")}`;
		});

		return [top, ...framed, bottom].map((l) => truncateToWidth(l, width));
	}

	invalidate(): void {
		this.markdown = new Markdown(this.buildContent(), 1, 0, getMarkdownTheme());
	}

	private scroll(delta: number): void {
		const max = Math.max(0, this.totalLines - this.viewHeight);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, max));
	}
}

// ── Delete Confirmation Component ────────────────────────────────────────────

export class MemoryDeleteConfirmComponent extends Container {
	private selectList: SelectList;

	constructor(theme: Theme, message: string, onConfirm: (confirmed: boolean) => void) {
		super();

		const options: SelectItem[] = [
			{ value: "yes", label: "Yes, delete" },
			{ value: "no", label: "No, keep it" },
		];

		this.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));
		this.addChild(new Text(theme.fg("error", message)));

		this.selectList = new SelectList(options, options.length, {
			selectedPrefix: (text) => theme.fg("error", text),
			selectedText: (text) => theme.fg("error", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		this.selectList.onSelect = (item) => onConfirm(item.value === "yes");
		this.selectList.onCancel = () => onConfirm(false);

		this.addChild(this.selectList);
		this.addChild(new Text(theme.fg("dim", "Enter confirm • Esc cancel")));
		this.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
	}
}
