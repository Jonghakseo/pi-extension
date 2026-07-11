/**
 * Formatting and display utility functions for the Subagent tool.
 */

import * as os from "node:os";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { normalizeModelRef as normalizeModelRefUtil } from "./utils/format-utils.js";

export {
	AGENT_NAME_PALETTE,
	agentBgIndex,
	formatContextUsageBar,
	formatTokens,
	formatUsageStats,
	getContextBarColorByRemaining,
	getRemainingContextPercent,
	getUsedContextPercent,
	truncateLines,
	truncatePlainToWidth,
	truncateToWidthWithEllipsis,
} from "./utils/format-utils.js";
export const normalizeModelRef = normalizeModelRefUtil;

// ─── Context Usage ───────────────────────────────────────────────────────────

type ContextWindowResolverContext = {
	model?: { contextWindow?: number };
	modelRegistry?: {
		getAll: () => Array<{ provider: string; id: string; contextWindow?: number }>;
	};
};

type ThemeFg = (color: ThemeColor, text: string) => string;

export function resolveContextWindow(ctx: ContextWindowResolverContext, modelRef?: string): number | undefined {
	const fallback = ctx?.model?.contextWindow;
	if (!ctx?.modelRegistry || typeof ctx.modelRegistry.getAll !== "function") return fallback;
	const models = ctx.modelRegistry.getAll() as Array<{ provider: string; id: string; contextWindow?: number }>;
	if (!modelRef) return fallback;

	const normalized = normalizeModelRef(modelRef);
	if (normalized.provider) {
		const exact = models.find((m) => m.provider === normalized.provider && m.id === normalized.id);
		if (exact?.contextWindow) return exact.contextWindow;
	}

	const byId = models.find((m) => m.id === normalized.id);
	if (byId?.contextWindow) return byId.contextWindow;

	return fallback;
}

// ─── Tool Call Formatting ────────────────────────────────────────────────────

function stringifyPreviewValue(value: unknown): string {
	if (value === undefined || value === null) return "...";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const parts = value.map((item) => stringifyPreviewValue(item));
		return parts.length > 3 ? `${parts.slice(0, 3).join(", ")}, ...` : parts.join(", ");
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatPathValueForPreview(value: unknown): string {
	const text = stringifyPreviewValue(value);
	const home = os.homedir();
	return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

export function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: ThemeFg): string {
	const shortenPath = (value: unknown) => formatPathValueForPreview(value);

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = args.file_path || args.path || "...";
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = args.file_path || args.path || "...";
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = args.file_path || args.path || "...";
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = args.path || ".";
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = args.path || ".";
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = args.path || ".";
			return (
				themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function shortenPathForPreview(p: unknown): string {
	return formatPathValueForPreview(p);
}

export function formatToolCallPlain(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return `$ ${preview}`;
		}
		case "read": {
			const rawPath = args.file_path || args.path || "...";
			const filePath = shortenPathForPreview(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				return `read ${filePath}:${startLine}${endLine ? `-${endLine}` : ""}`;
			}
			return `read ${filePath}`;
		}
		case "write": {
			const rawPath = args.file_path || args.path || "...";
			const filePath = shortenPathForPreview(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			return lines > 1 ? `write ${filePath} (${lines} lines)` : `write ${filePath}`;
		}
		case "edit": {
			const rawPath = args.file_path || args.path || "...";
			return `edit ${shortenPathForPreview(rawPath)}`;
		}
		case "ls": {
			const rawPath = args.path || ".";
			return `ls ${shortenPathForPreview(rawPath)}`;
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = args.path || ".";
			return `find ${pattern} in ${shortenPathForPreview(rawPath)}`;
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = args.path || ".";
			return `grep /${pattern}/ in ${shortenPathForPreview(rawPath)}`;
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return `${toolName} ${preview}`;
		}
	}
}
