/**
 * Pure formatting utility functions extracted from various extensions.
 *
 * These functions convert data into display-ready strings. They have no
 * side effects and depend only on their arguments and Node built-ins.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfigLike } from "./agent-utils.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type { AgentConfigLike };

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns?: number;
}

export interface CommandRunSummaryInput {
	id: number;
	status: string;
	agent: string;
	contextMode?: string;
	turnCount?: number;
	elapsedMs: number;
	toolCalls: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Vibrant ANSI-256 foreground colors for per-agent name coloring. */
export const AGENT_NAME_PALETTE = [39, 208, 114, 204, 220, 141, 81, 209, 156, 177];

// ─── USD / Token Formatting ──────────────────────────────────────────────────

/** Format a cost value as a USD string with adaptive precision. */
export function formatUsd(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

/** Rough token estimate from text length (~4 chars/token). */
export function estimateTokens(text: string): number {
	return Math.max(0, Math.ceil(text.length / 4));
}

/**
 * Safely extract a total cost number from a usage object.
 * Handles `{ cost: number }`, `{ cost: string }`, `{ cost: { total: number } }`.
 */
export function extractCostTotal(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const rec = usage as Record<string, unknown>;
	const c = rec.cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	if (typeof c === "string") {
		const n = Number(c);
		return Number.isFinite(n) ? n : 0;
	}
	if (c && typeof c === "object") {
		const t = (c as Record<string, unknown>).total;
		if (typeof t === "number") return Number.isFinite(t) ? t : 0;
		if (typeof t === "string") {
			const n = Number(t);
			return Number.isFinite(n) ? n : 0;
		}
	}
	return 0;
}

/** Format a token count to a compact string (e.g. "1.2k", "300k", "1.5M"). */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Build a compact usage stats summary string.
 *
 * Format example: `3 turns ↑12k ↓4.2k R8k W1k $0.0521 ctx:32k sonnet`
 */
export function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

// ─── Model / Context ─────────────────────────────────────────────────────────

/** Split a model reference into optional provider and id. */
export function normalizeModelRef(modelRef: string): { provider?: string; id: string } {
	const cleaned = modelRef.trim().split(":")[0] ?? modelRef.trim();
	if (cleaned.includes("/")) {
		const [provider, ...idParts] = cleaned.split("/");
		return { provider, id: idParts.join("/") };
	}
	return { id: cleaned };
}

/** Compute percentage of context window used (0–100), or undefined if unavailable. */
export function getUsedContextPercent(contextTokens?: number, contextWindow?: number): number | undefined {
	if (!contextWindow || contextWindow <= 0) return undefined;
	if (contextTokens === undefined || contextTokens === null || contextTokens < 0) return undefined;
	return Math.max(0, Math.min(100, Math.round((contextTokens / contextWindow) * 100)));
}

/** Compute percentage of context window remaining (0–100). */
export function getRemainingContextPercent(usedPercent?: number): number | undefined {
	if (usedPercent === undefined || usedPercent === null) return undefined;
	return Math.max(0, Math.min(100, 100 - usedPercent));
}

/**
 * Render a text-based context usage bar.
 * Example: `[■■■■■□□□□□] 50%`
 */
export function formatContextUsageBar(percent: number, width = 10): string {
	const clamped = Math.max(0, Math.min(100, Math.round(percent)));
	const barWidth = Math.max(4, width);
	const filled = Math.round((clamped / 100) * barWidth);
	return `[${"■".repeat(filled)}${"□".repeat(barWidth - filled)}] ${clamped}%`;
}

/** Map remaining context percentage to a color severity. */
export function getContextBarColorByRemaining(remainingPercent: number): "warning" | "error" | undefined {
	if (remainingPercent <= 15) return "error";
	if (remainingPercent <= 40) return "warning";
	return undefined;
}

// ─── Agent Formatting ────────────────────────────────────────────────────────

/** Deterministic index into AGENT_NAME_PALETTE based on agent name hash. */
export function agentBgIndex(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) {
		h = ((h << 5) - h + name.charCodeAt(i)) | 0;
	}
	return Math.abs(h) % AGENT_NAME_PALETTE.length;
}

/** Truncate text to at most `maxLines` lines, appending "..." if truncated. */
export function truncateLines(text: string, maxLines = 2): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return `${lines.slice(0, maxLines).join("\n")}\n...`;
}

function sliceToDisplayWidth(value: string, maxWidth: number): string {
	if (maxWidth <= 0 || value.length === 0) return "";

	let result = "";
	let width = 0;

	for (const { segment } of graphemeSegmenter.segment(value)) {
		const segmentWidth = visibleWidth(segment);
		if (segmentWidth <= 0) {
			result += segment;
			continue;
		}
		if (width + segmentWidth > maxWidth) break;
		result += segment;
		width += segmentWidth;
	}

	return result;
}

/**
 * Truncate plain text to display width and append an ellipsis when truncation occurs.
 * Apply terminal styles after calling this helper so the ellipsis inherits the intended style.
 */
export function truncatePlainToWidth(value: string, maxWidth: number, ellipsis = "..."): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(value) <= maxWidth) return value;
	if (!ellipsis) return sliceToDisplayWidth(value, maxWidth);

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) return sliceToDisplayWidth(ellipsis, maxWidth);
	return `${sliceToDisplayWidth(value, maxWidth - ellipsisWidth)}${ellipsis}`;
}

/**
 * Truncate a single line to display width and append "..." when truncation occurs.
 * Uses terminal display width (CJK-aware) rather than string length.
 */
export function truncateToWidthWithEllipsis(value: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(value) <= maxWidth) return value;
	if (maxWidth <= 3) return sliceToDisplayWidth(value, maxWidth);
	return truncatePlainToWidth(value, maxWidth, "...");
}

/**
 * One-line summary of a command run.
 *
 * Format: `#<id> [<status>] <agent> ctx:<contextMode> turn:<turnCount> <elapsed>s tools:<toolCalls>`
 */
export function formatCommandRunSummary(run: CommandRunSummaryInput): string {
	const elapsedSec = Math.max(0, Math.round(run.elapsedMs / 1000));
	const contextLabel = run.contextMode === "main" ? "main" : "isolated";
	return `#${run.id} [${run.status}] ${run.agent} ctx:${contextLabel} turn:${run.turnCount ?? 1} ${elapsedSec}s tools:${run.toolCalls}`;
}

/** Format a list of agents for display. */
export function formatAgentList(agents: AgentConfigLike[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

// ─── GitHub Formatting ───────────────────────────────────────────────────────

/** Format a state string for display (replace underscores, uppercase). */
export function formatStateLabel(value: string | null): string {
	if (!value) return "UNKNOWN";
	return value.replace(/_/g, " ").toUpperCase();
}

// ─── Purpose Formatting ──────────────────────────────────────────────────────

/** Format a purpose string for status bar display (normalizes whitespace, clips). */
export function formatPurposeStatus(purpose: string): string {
	const singleLine = typeof purpose !== "string" ? "" : purpose.replace(/\s+/g, " ").trim();
	const maxChars = 90;
	const clipped = singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 1)}…` : singleLine;
	return `🎯 ${clipped}`;
}
