import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { MemoryScope, MemoryTier } from "./types.ts";

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
	agent?: number;
	user: number;
	project: number;
	topics: number;
};

export type MemoryToolDetails =
	| { kind: "remember"; scope: MemoryScope; tier?: MemoryTier; topic: string; title: string }
	| {
			kind: "recall-query";
			total: number;
			matches: ReadonlyArray<{ scope: MemoryScope; tier?: MemoryTier; topic: string; title: string }>;
	  }
	| { kind: "recall-id"; scope: MemoryScope; tier?: MemoryTier; topic: string; title: string }
	| ({ kind: "recall-index"; scope?: MemoryScope; tier?: MemoryTier } & MemoryCountDetails)
	| { kind: "forget"; scope: MemoryScope; tier?: MemoryTier; topic: string; title: string }
	| ({ kind: "memory-list"; scope?: MemoryScope; tier?: MemoryTier } & MemoryCountDetails);

const CALL_PREVIEW_WIDTH = 60;
const RESULT_TITLE_WIDTH = 32;

function stringArg(args: ToolRenderArgs, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function preview(value: string, width: number): string {
	return truncateToWidth(value.replace(/\s+/g, " ").trim(), width, "...");
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
	const agent = details.agent ?? 0;
	const total = agent + details.user + details.project;
	if (total === 0) return "○ no memories";
	if (details.scope === "user")
		return `✓ ${formatCount(details.user, "memory", "memories")} · ${formatCount(details.topics, "topic")}`;
	if (details.scope === "project") {
		return `✓ ${formatCount(details.project, "memory", "memories")} · ${formatCount(details.topics, "topic")}`;
	}
	if (details.scope === "agent") {
		return `✓ ${formatCount(agent, "memory", "memories")} · ${formatCount(details.topics, "topic")}`;
	}
	return `✓ ${formatCount(total, "memory", "memories")} · agent ${agent} / user ${details.user} / project ${details.project}`;
}

export function renderRememberCall(args: ToolRenderArgs, theme: RenderTheme, context: { expanded: boolean }): Text {
	if (context.expanded) return renderExpandedFallback("remember", theme);
	const scope = stringArg(args, "scope") ?? "project";
	const topic = stringArg(args, "topic") ?? "general";
	const tier = stringArg(args, "tier") ?? "profile";
	const title = stringArg(args, "title") ?? stringArg(args, "content") ?? "(empty)";
	const text = `${renderTitle("remember", theme)} · ${memoryLocation(scope, topic)} · ${tier} · "${preview(title, CALL_PREVIEW_WIDTH)}"`;
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
	const tier = stringArg(args, "tier");
	let text = renderTitle("recall", theme);

	if (context.expanded) {
		if (id) text += ` ${theme.fg("accent", `id:${id}`)}`;
		if (query) text += ` ${theme.fg("accent", `"${query}"`)}`;
		if (scope) text += ` ${theme.fg("accent", `scope:${scope}`)}`;
		if (tier) text += ` ${theme.fg("accent", `tier:${tier}`)}`;
		if (!query && !id) text += ` ${theme.fg("muted", "(index)")}`;
		return new Text(text, 0, 0);
	}

	if (id) return new Text(`${text} · id:${preview(id, 8)}`, 0, 0);
	if (query)
		return new Text(
			`${text} · "${preview(query, CALL_PREVIEW_WIDTH)}" · ${scope ?? "all"}${tier ? `/${tier}` : ""}`,
			0,
			0,
		);
	return new Text(`${text} · index · ${scope ?? "all"}${tier ? `/${tier}` : ""}`, 0, 0);
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
	const id = stringArg(args, "id") ?? "(empty)";
	return new Text(`${renderTitle("forget", theme)} · ID ${id}`, 0, 0);
}

export function renderForgetResult(
	result: ToolRenderResult,
	options: ToolResultOptions,
	theme: RenderTheme,
	_context: ToolRenderContext,
): Text {
	if (options.expanded) return renderOutput(result, theme);
	const details = result.details as MemoryToolDetails | undefined;
	if (details?.kind !== "forget") return renderOutput(result, theme);
	return renderSummary(`✓ deleted · ${details.scope}/${details.topic}`, theme);
}

export function renderMemoryListCall(args: ToolRenderArgs, theme: RenderTheme, context: { expanded: boolean }): Text {
	if (context.expanded) return renderExpandedFallback("memory_list", theme);
	return new Text(
		`${renderTitle("memory_list", theme)} · ${stringArg(args, "scope") ?? "all"}${stringArg(args, "tier") ? `/${stringArg(args, "tier")}` : ""}`,
		0,
		0,
	);
}

export function renderMemoryListResult(result: ToolRenderResult, options: ToolResultOptions, theme: RenderTheme): Text {
	if (options.expanded) return renderOutput(result, theme);
	const details = result.details as MemoryToolDetails | undefined;
	if (details?.kind !== "memory-list") return renderOutput(result, theme);
	return renderSummary(renderCountSummary(details), theme);
}
