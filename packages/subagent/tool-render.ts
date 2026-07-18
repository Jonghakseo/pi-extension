/**
 * Rendering functions for the subagent tool's renderCall / renderResult.
 *
 * Extracted from commands.ts — output format is identical.
 */

import { getMarkdownTheme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { parseSubagentToolCommand } from "./cli.js";
import { SUBAGENT_STRONG_WAIT_MESSAGE } from "./constants.js";
import { formatToolCall, formatUsageStats } from "./format.js";
import { getDisplayItems, getFinalOutput } from "./runner.js";
import { COLLAPSED_ITEM_COUNT, truncateText } from "./store.js";
import type { DisplayItem, SubagentDetails } from "./types.js";

// ─── Helpers (internal) ──────────────────────────────────────────────────────

type RenderTheme = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
};

type ToolRenderResult = {
	details?: unknown;
	content: Array<{ type?: string; text?: string }>;
};

type ToolRenderArgs = { command?: unknown };
type ToolCallRenderContext = { expanded: boolean };
type CompactBlock = { agent: string; task: string };
type ListAgentsDetails = { agents?: Array<{ name?: unknown }> };

const COMPACT_TASK_PREVIEW_WIDTH = 72;
const COMPACT_AGENT_WIDTH = 20;
const COMPACT_MAX_ITEMS = 3;
const COMPACT_AGENT_LIST_COUNT = 3;

function normalizeTaskPreview(task: string): string {
	return truncateText(task.replace(/\s+/g, " ").trim(), COMPACT_TASK_PREVIEW_WIDTH);
}

function getContextLabel(params: Record<string, unknown>): "main" | "isolated" {
	return params.contextMode === "main" ? "main" : "isolated";
}

function getCompactBlocks(value: unknown): CompactBlock[] | null {
	if (!Array.isArray(value)) return null;
	const blocks: CompactBlock[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") return null;
		const agent = "agent" in item ? item.agent : undefined;
		const task = "task" in item ? item.task : undefined;
		if (typeof agent !== "string" || typeof task !== "string") return null;
		blocks.push({ agent, task });
	}
	return blocks;
}

function formatCompactAgent(agent: string, width: number): string {
	const label = truncateText(agent, COMPACT_AGENT_WIDTH);
	return `${label}${" ".repeat(Math.max(0, width - visibleWidth(label)))}`;
}

function renderCompactBlocks(kind: "batch" | "chain", params: Record<string, unknown>): string | null {
	const blocks = getCompactBlocks(kind === "batch" ? params.runs : params.steps);
	if (!blocks || blocks.length === 0) return null;

	const visibleBlocks = blocks.slice(0, COMPACT_MAX_ITEMS);
	const agentWidth = Math.max(
		...visibleBlocks.map((block) => visibleWidth(truncateText(block.agent, COMPACT_AGENT_WIDTH))),
	);
	const contextLabel = getContextLabel(params);
	const executionLabel = kind === "batch" ? "parallel" : "sequential";
	const lines = [`  ${kind} · ${contextLabel} · ${blocks.length} ${executionLabel}`];

	for (const [index, block] of visibleBlocks.entries()) {
		const agent = formatCompactAgent(block.agent, agentWidth);
		const task = normalizeTaskPreview(block.task);
		if (kind === "batch") {
			lines.push(`  ∥ ${agent}  ${task}`);
			continue;
		}

		const connector = index === 0 ? "" : `${"   ".repeat(index - 1)}└─ `;
		lines.push(`  ${connector}${index + 1} ${agent}  ${task}`);
	}

	const hiddenCount = blocks.length - visibleBlocks.length;
	if (hiddenCount > 0) {
		if (kind === "batch") lines.push(`  ∥ +${hiddenCount} jobs`);
		else lines.push(`  ${"   ".repeat(visibleBlocks.length - 1)}└─ +${hiddenCount} steps`);
	}

	return lines.join("\n");
}

function renderCompactLaunch(command: unknown): string | null {
	const parsed = parseSubagentToolCommand(command);
	if (parsed.type !== "params") return null;

	const { params } = parsed;
	if (params.asyncAction === "batch") return renderCompactBlocks("batch", params);
	if (params.asyncAction === "chain") return renderCompactBlocks("chain", params);
	if (typeof params.task !== "string") return null;

	const contextLabel = getContextLabel(params);
	const task = normalizeTaskPreview(params.task);
	if (typeof params.runId === "number") {
		const agent = typeof params.agent === "string" ? ` · ${params.agent}` : "";
		return `  continue · #${params.runId}${agent} · ${contextLabel}\n  ${task}`;
	}
	if (typeof params.agent !== "string") return null;
	return `  run · ${params.agent} · ${contextLabel}\n  ${task}`;
}

function getToolResultText(result: ToolRenderResult): string {
	const raw = result.content[0];
	return (raw?.type === "text" ? raw.text : undefined) ?? "(no output)";
}

function renderPlainToolResult(fullText: string, expanded: boolean, theme: RenderTheme): Text {
	if (expanded) return new Text(fullText, 0, 0);

	const waitMessageIndex = fullText.indexOf(SUBAGENT_STRONG_WAIT_MESSAGE);
	if (waitMessageIndex >= 0) {
		return new Text(fullText.slice(0, waitMessageIndex).trimEnd(), 0, 0);
	}

	const firstLine = fullText.split("\n")[0] ?? "";
	const lineCount = fullText.split("\n").length;
	const suffix = lineCount > 1 ? theme.fg("muted", ` (+${lineCount - 1} lines)`) : "";
	return new Text(firstLine + suffix, 0, 0);
}

function renderDisplayItems(items: DisplayItem[], expanded: boolean, theme: RenderTheme, limit?: number): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

// ─── renderCall ──────────────────────────────────────────────────────────────

export function renderListAgentsCall(_args: unknown, theme: RenderTheme) {
	return new Text(theme.fg("toolTitle", theme.bold("list-agents")), 0, 0);
}

export function renderListAgentsResult(
	result: ToolRenderResult,
	{ expanded }: { expanded: boolean },
	theme: RenderTheme,
) {
	const fullText = getToolResultText(result);
	if (expanded) return new Text(theme.fg("toolOutput", fullText), 0, 0);

	const details = result.details as ListAgentsDetails | undefined;
	const names = details?.agents
		?.map((agent) => (typeof agent.name === "string" ? truncateText(agent.name, COMPACT_AGENT_WIDTH) : ""))
		.filter(Boolean);
	if (!names) return new Text(theme.fg("toolOutput", fullText.split("\n")[0] ?? fullText), 0, 0);
	if (names.length === 0) return new Text(theme.fg("muted", "○ no agents"), 0, 0);

	const visibleNames = names.slice(0, COMPACT_AGENT_LIST_COUNT);
	const hiddenCount = names.length - visibleNames.length;
	const hiddenSuffix = hiddenCount > 0 ? `, +${hiddenCount}` : "";
	return new Text(
		theme.fg(
			"toolOutput",
			`✓ ${names.length} agent${names.length === 1 ? "" : "s"} · ${visibleNames.join(", ")}${hiddenSuffix}`,
		),
		0,
		0,
	);
}

export function renderSubagentToolCall(
	args: ToolRenderArgs,
	theme: RenderTheme,
	context: ToolCallRenderContext = { expanded: false },
) {
	const raw = typeof args.command === "string" ? args.command.trim() : "";
	const command = raw || "subagent help";
	let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", "cli");

	if (!context.expanded) {
		const compactLaunch = renderCompactLaunch(args.command);
		if (compactLaunch) return new Text(`${text}\n${theme.fg("dim", compactLaunch)}`, 0, 0);
	}

	const MAX_CALL_LINES = 5;
	const commandLines = command.split("\n");
	const truncated = commandLines.length > MAX_CALL_LINES;
	const preview = truncated ? commandLines.slice(0, MAX_CALL_LINES).join("\n") : command;

	text += `\n  ${theme.fg("dim", preview)}`;
	if (truncated) text += `\n  ${theme.fg("muted", `... +${commandLines.length - MAX_CALL_LINES} more lines`)}`;
	return new Text(text, 0, 0);
}

// ─── renderResult ────────────────────────────────────────────────────────────

export function renderSubagentToolResult(
	result: ToolRenderResult,
	{ expanded }: { expanded: boolean },
	theme: RenderTheme,
) {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		return renderPlainToolResult(getToolResultText(result), expanded, theme);
	}

	const mdTheme = getMarkdownTheme();
	const r = details.results[0];
	if (!r) return renderPlainToolResult(getToolResultText(result), expanded, theme);

	const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);

	if (expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		container.addChild(new Text(header, 0, 0));
		if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "task:"), 0, 0));
		container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "──────────────"), 0, 0));
		container.addChild(new Spacer(1));
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
					);
				}
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
	if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
	else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
	else {
		text += `\n${renderDisplayItems(displayItems, expanded, theme, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return new Text(text, 0, 0);
}
