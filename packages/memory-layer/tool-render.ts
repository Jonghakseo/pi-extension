import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { MemoryScope } from "./types.ts";

type RenderTheme = {
	fg: (color: ThemeColor, text: string) => string;
	bold: (text: string) => string;
};

type ToolRenderArgs = Record<string, unknown>;
type ToolRenderResult = {
	content: Array<{ type?: string; text?: string }>;
	details?: unknown;
};
type ToolResultOptions = { expanded: boolean };
type ToolRenderContext = { args: ToolRenderArgs };

type MemoryCountDetails = {
	user: number;
	project: number;
	topics: number;
};

export type MemoryToolDetails =
	| { kind: "remember"; scope: MemoryScope; topic: string; title: string }
	| {
			kind: "recall-query";
			total: number;
			matches: ReadonlyArray<{ scope: MemoryScope; topic: string; title: string }>;
	  }
	| { kind: "recall-id"; scope: MemoryScope; topic: string; title: string }
	| ({ kind: "recall-index"; scope?: MemoryScope } & MemoryCountDetails)
	| { kind: "forget"; scope: MemoryScope; topic: string; title: string }
	| ({ kind: "memory-list"; scope?: MemoryScope } & MemoryCountDetails);

const CALL_PREVIEW_WIDTH = 60;
const RESULT_TITLE_WIDTH = 32;

function stringArg(args: ToolRenderArgs, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function preview(value: string, width: number): string {
	return truncateToWidth(value.replace(/\s+/g, " ").trim(), width, "…");
}

function renderTitle(name: string, theme: RenderTheme): string {
	return theme.fg("toolTitle", theme.bold(name));
}

function renderExpandedFallback(name: string, theme: RenderTheme): Text {
	return new Text(renderTitle(name, theme), 0, 0);
}

function renderOutput(result: ToolRenderResult, theme: RenderTheme): Text {
	const content = result.content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
	return new Text(theme.fg("toolOutput", content), 0, 0);
}

function renderSummary(text: string, theme: RenderTheme): Text {
	return new Text(theme.fg("toolOutput", text), 0, 0);
}

function memoryLocation(scope: string | undefined, topic: string | undefined): string {
	if (scope && topic) return `${scope}/${topic.replace(/\.md$/i, "")}`;
	if (scope) return scope;
	if (topic) return `auto/${topic.replace(/\.md$/i, "")}`;
	return "auto";
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function renderCountSummary(details: MemoryCountDetails & { scope?: MemoryScope }): string {
	const total = details.user + details.project;
	if (total === 0) return "○ no memories";
	if (details.scope === "user")
		return `✓ ${formatCount(details.user, "memory", "memories")} · ${formatCount(details.topics, "topic")}`;
	if (details.scope === "project") {
		return `✓ ${formatCount(details.project, "memory", "memories")} · ${formatCount(details.topics, "topic")}`;
	}
	return `✓ ${formatCount(total, "memory", "memories")} · user ${details.user} / project ${details.project}`;
}

export function renderRememberCall(args: ToolRenderArgs, theme: RenderTheme, context: { expanded: boolean }): Text {
	if (context.expanded) return renderExpandedFallback("remember", theme);
	const scope = stringArg(args, "scope") ?? "project";
	const topic = stringArg(args, "topic") ?? "general";
	const title = stringArg(args, "title") ?? stringArg(args, "content") ?? "(empty)";
	const text = `${renderTitle("remember", theme)} · ${memoryLocation(scope, topic)} · "${preview(title, CALL_PREVIEW_WIDTH)}"`;
	return new Text(text, 0, 0);
}

export function renderRememberResult(result: ToolRenderResult, options: ToolResultOptions, theme: RenderTheme): Text {
	if (options.expanded || (result.details as MemoryToolDetails | undefined)?.kind !== "remember") {
		return renderOutput(result, theme);
	}
	return renderSummary("✓ saved", theme);
}

export function renderRecallCall(args: ToolRenderArgs, theme: RenderTheme, context: { expanded: boolean }): Text {
	const query = stringArg(args, "query");
	const id = stringArg(args, "id");
	const scope = stringArg(args, "scope");
	let text = renderTitle("recall", theme);

	if (context.expanded) {
		if (id) text += ` ${theme.fg("accent", `id:${id}`)}`;
		if (query) text += ` ${theme.fg("accent", `"${query}"`)}`;
		if (scope) text += ` ${theme.fg("accent", `scope:${scope}`)}`;
		if (!query && !id) text += ` ${theme.fg("muted", "(index)")}`;
		return new Text(text, 0, 0);
	}

	if (id) return new Text(`${text} · id:${preview(id, 8)}`, 0, 0);
	if (query) return new Text(`${text} · "${preview(query, CALL_PREVIEW_WIDTH)}" · ${scope ?? "all"}`, 0, 0);
	return new Text(`${text} · index · ${scope ?? "all"}`, 0, 0);
}

export function renderRecallResult(result: ToolRenderResult, options: ToolResultOptions, theme: RenderTheme): Text {
	if (options.expanded) return renderOutput(result, theme);
	const details = result.details as MemoryToolDetails | undefined;
	if (!details?.kind.startsWith("recall-")) return renderOutput(result, theme);

	if (details.kind === "recall-query") {
		if (details.total === 0) return renderSummary("○ no matches", theme);
		const titles = details.matches.slice(0, 2).map((match) => preview(match.title, RESULT_TITLE_WIDTH));
		const hidden = details.total - titles.length;
		const suffix = hidden > 0 ? `, +${hidden}` : "";
		return renderSummary(`✓ ${formatCount(details.total, "match", "matches")} · ${titles.join(", ")}${suffix}`, theme);
	}
	if (details.kind === "recall-id") {
		return renderSummary(`✓ ${details.scope}/${details.topic} · ${preview(details.title, CALL_PREVIEW_WIDTH)}`, theme);
	}
	if (details.kind === "recall-index") return renderSummary(renderCountSummary(details), theme);
	return renderOutput(result, theme);
}

export function renderForgetCall(args: ToolRenderArgs, theme: RenderTheme, context: { expanded: boolean }): Text {
	if (context.expanded) return renderExpandedFallback("forget", theme);
	const scope = stringArg(args, "scope");
	const topic = stringArg(args, "topic");
	const title = stringArg(args, "title") ?? "(empty)";
	return new Text(
		`${renderTitle("forget", theme)} · ${memoryLocation(scope, topic)} · "${preview(title, CALL_PREVIEW_WIDTH)}"`,
		0,
		0,
	);
}

export function renderForgetResult(
	result: ToolRenderResult,
	options: ToolResultOptions,
	theme: RenderTheme,
	context: ToolRenderContext,
): Text {
	if (options.expanded) return renderOutput(result, theme);
	const details = result.details as MemoryToolDetails | undefined;
	if (details?.kind !== "forget") return renderOutput(result, theme);
	const hasExactTarget = Boolean(stringArg(context.args, "scope") && stringArg(context.args, "topic"));
	const target = hasExactTarget ? "" : ` · ${details.scope}/${details.topic}`;
	return renderSummary(`✓ deleted${target}`, theme);
}

export function renderMemoryListCall(args: ToolRenderArgs, theme: RenderTheme, context: { expanded: boolean }): Text {
	if (context.expanded) return renderExpandedFallback("memory_list", theme);
	return new Text(`${renderTitle("memory_list", theme)} · ${stringArg(args, "scope") ?? "all"}`, 0, 0);
}

export function renderMemoryListResult(result: ToolRenderResult, options: ToolResultOptions, theme: RenderTheme): Text {
	if (options.expanded) return renderOutput(result, theme);
	const details = result.details as MemoryToolDetails | undefined;
	if (details?.kind !== "memory-list") return renderOutput(result, theme);
	return renderSummary(renderCountSummary(details), theme);
}
