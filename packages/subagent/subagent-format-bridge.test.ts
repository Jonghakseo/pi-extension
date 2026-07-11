import { describe, expect, it } from "vitest";
import { formatSymbolHints, formatSymbolHints as subagentFormatSymbolHints } from "./constants.js";
import {
	formatToolCallPlain,
	resolveContextWindow,
	AGENT_NAME_PALETTE as SUBAGENT_NAME_PALETTE,
	agentBgIndex as subagentAgentBgIndex,
	formatContextUsageBar as subagentFormatContextUsageBar,
	formatTokens as subagentFormatTokens,
	formatUsageStats as subagentFormatUsageStats,
	getContextBarColorByRemaining as subagentGetContextBarColorByRemaining,
	getRemainingContextPercent as subagentGetRemainingContextPercent,
	getUsedContextPercent as subagentGetUsedContextPercent,
	normalizeModelRef as subagentNormalizeModelRef,
	truncateLines as subagentTruncateLines,
} from "./format.js";
import {
	AGENT_NAME_PALETTE,
	agentBgIndex,
	formatContextUsageBar,
	formatTokens,
	formatUsageStats,
	getContextBarColorByRemaining,
	getRemainingContextPercent,
	getUsedContextPercent,
	truncateLines,
} from "./utils/format-utils.js";

describe("subagent format bridges", () => {
	it("reuses token/usage formatting from format-utils", () => {
		expect(subagentFormatTokens(9999)).toBe(formatTokens(9999));
		expect(
			subagentFormatUsageStats({ input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0012, turns: 2 }),
		).toBe(formatUsageStats({ input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.0012, turns: 2 }));
		expect(subagentNormalizeModelRef("anthropic/claude-sonnet:thinking")).toEqual({
			provider: "anthropic",
			id: "claude-sonnet",
		});
	});

	it("reuses context helpers from format-utils", () => {
		expect(subagentGetUsedContextPercent(400, 800)).toBe(getUsedContextPercent(400, 800));
		expect(subagentGetRemainingContextPercent(25)).toBe(getRemainingContextPercent(25));
		expect(subagentFormatContextUsageBar(35, 10)).toBe(formatContextUsageBar(35, 10));
		expect(subagentGetContextBarColorByRemaining(15)).toBe(getContextBarColorByRemaining(15));
	});

	it("reuses palette/hash helpers from format-utils", () => {
		expect(SUBAGENT_NAME_PALETTE).toEqual(AGENT_NAME_PALETTE);
		expect(subagentAgentBgIndex("worker")).toBe(agentBgIndex("worker"));
		expect(subagentTruncateLines("a\nb\nc", 2)).toBe(truncateLines("a\nb\nc", 2));
	});
});

describe("subagent constants", () => {
	it("formatSymbolHints uses configured mappings and prefixes", () => {
		const symbolMap = { "?": "searcher", "!": "reviewer" };
		expect(formatSymbolHints(symbolMap)).toBe(">>? searcher  >>! reviewer");
		expect(formatSymbolHints(symbolMap, ">")).toBe(">? searcher  >! reviewer");
		expect(formatSymbolHints({})).toBe("");
	});

	it("subagentFormatSymbolHints is the same function", () => {
		expect(subagentFormatSymbolHints({})).toBe(formatSymbolHints({}));
		expect(subagentFormatSymbolHints({ "?": "searcher" }, ">")).toBe(formatSymbolHints({ "?": "searcher" }, ">"));
	});
});

describe("subagent-specific formatting behavior", () => {
	it("resolves model context window by provider/id and id fallback", () => {
		const ctx = {
			model: { contextWindow: 4096 },
			modelRegistry: {
				getAll: () => [
					{ provider: "anthropic", id: "claude-sonnet", contextWindow: 200000 },
					{ provider: "openai", id: "gpt-4.1", contextWindow: 128000 },
				],
			},
		};

		expect(resolveContextWindow(ctx, "anthropic/claude-sonnet")).toBe(200000);
		expect(resolveContextWindow(ctx, "gpt-4.1")).toBe(128000);
		expect(resolveContextWindow(ctx, "unknown/model")).toBe(4096);
	});

	it("formats plain tool call previews without changing output shape", () => {
		expect(formatToolCallPlain("bash", { command: "echo hello" })).toBe("$ echo hello");
		expect(formatToolCallPlain("read", { path: "/tmp/a.txt", offset: 10, limit: 5 })).toBe("read /tmp/a.txt:10-14");
		expect(formatToolCallPlain("write", { path: "/tmp/a.txt", content: "a\nb" })).toBe("write /tmp/a.txt (2 lines)");
	});
});
