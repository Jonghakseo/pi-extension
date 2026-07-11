import { describe, expect, it } from "vitest";
import {
	AGENT_THINKING_LEVELS,
	type AgentConfigLike,
	CLAUDE_MODEL_ALIAS_MAP,
	computeAgentAliasHints,
	getAgentInitials,
	getSubCommandAgentCompletions,
	isClaudeModel,
	matchSubCommandAgent,
	normalizeAgentAlias,
	normalizeModel,
	normalizeThinkingLevel,
	normalizeTools,
	uniqueAgentsByName,
} from "./agent-utils.ts";

// ── Helper ───────────────────────────────────────────────────────────────────

function mkAgent(name: string, description = "", source = "user"): AgentConfigLike {
	return { name, description, source };
}

const STANDARD_AGENTS: AgentConfigLike[] = [
	mkAgent("worker", "Do work"),
	mkAgent("reviewer", "Review code"),
	mkAgent("verifier", "Verify results"),
	mkAgent("searcher", "Search things"),
];

// ── normalizeTools ───────────────────────────────────────────────────────────

describe("normalizeTools", () => {
	it("should return undefined for undefined input", () => {
		expect(normalizeTools(undefined, "pi")).toBeUndefined();
	});

	it("should return undefined for empty string", () => {
		expect(normalizeTools("", "pi")).toBeUndefined();
	});

	it("should split and trim pi tools", () => {
		expect(normalizeTools("read, write, bash", "pi")).toEqual(["read", "write", "bash"]);
	});

	it("should map Claude tools to pi equivalents", () => {
		expect(normalizeTools("bash,read,glob", "claude")).toEqual(["bash", "read", "find"]);
	});

	it("should deduplicate mapped tools", () => {
		expect(normalizeTools("todowrite,todoread", "claude")).toEqual(["todo"]);
	});

	it("should filter out unmappable Claude tools", () => {
		expect(normalizeTools("skill", "claude")).toBeUndefined();
	});
});

// ── normalizeModel ───────────────────────────────────────────────────────────

describe("normalizeModel", () => {
	it("should return undefined for undefined input", () => {
		expect(normalizeModel(undefined, "pi")).toBeUndefined();
	});

	it("should return undefined for empty string", () => {
		expect(normalizeModel("  ", "claude")).toBeUndefined();
	});

	it("should pass through pi models as-is", () => {
		expect(normalizeModel("claude-sonnet-4-6", "pi")).toBe("claude-sonnet-4-6");
	});

	it("should map Claude aliases", () => {
		expect(normalizeModel("opus", "claude")).toBe(CLAUDE_MODEL_ALIAS_MAP.opus);
		expect(normalizeModel("sonnet", "claude")).toBe(CLAUDE_MODEL_ALIAS_MAP.sonnet);
		expect(normalizeModel("haiku", "claude")).toBe(CLAUDE_MODEL_ALIAS_MAP.haiku);
	});

	it("should pass through slash-containing Claude models", () => {
		expect(normalizeModel("openai/gpt-4o", "claude")).toBe("openai/gpt-4o");
	});
});

// ── isClaudeModel ───────────────────────────────────────────────────────────

describe("isClaudeModel", () => {
	it("should detect Anthropic Claude models", () => {
		expect(isClaudeModel("anthropic/claude-opus-4-7")).toBe(true);
		expect(isClaudeModel("claude-sonnet-4-6")).toBe(true);
	});

	it("should reject non-Claude models", () => {
		expect(isClaudeModel("openai-codex/gpt-5.4")).toBe(false);
		expect(isClaudeModel(undefined)).toBe(false);
	});
});

// ── normalizeThinkingLevel ───────────────────────────────────────────────────

describe("normalizeThinkingLevel", () => {
	it("should return undefined for undefined input", () => {
		expect(normalizeThinkingLevel(undefined)).toBeUndefined();
	});

	it("should normalize case and trim", () => {
		expect(normalizeThinkingLevel("  HIGH  ")).toBe("high");
	});

	it("should reject invalid values", () => {
		expect(normalizeThinkingLevel("extreme")).toBeUndefined();
	});

	it("should accept all known levels", () => {
		for (const level of AGENT_THINKING_LEVELS) {
			expect(normalizeThinkingLevel(level)).toBe(level);
		}
	});
});

// ── normalizeAgentAlias ──────────────────────────────────────────────────────

describe("normalizeAgentAlias", () => {
	it("should lowercase and strip non-alphanumeric", () => {
		expect(normalizeAgentAlias("Code-Reviewer")).toBe("codereviewer");
	});

	it("should handle empty string", () => {
		expect(normalizeAgentAlias("")).toBe("");
	});

	it("should handle Korean characters (strips them)", () => {
		expect(normalizeAgentAlias("리뷰어-test")).toBe("test");
	});
});

// ── getAgentInitials ─────────────────────────────────────────────────────────

describe("getAgentInitials", () => {
	it("should return first letter of single word", () => {
		expect(getAgentInitials("worker")).toBe("w");
	});

	it("should return initials of hyphenated name", () => {
		expect(getAgentInitials("code-reviewer")).toBe("cr");
	});

	it("should handle empty string", () => {
		expect(getAgentInitials("")).toBe("");
	});

	it("should handle uppercase input", () => {
		expect(getAgentInitials("Code-Reviewer")).toBe("cr");
	});

	it("should handle multiple separators", () => {
		expect(getAgentInitials("my-super_agent")).toBe("msa");
	});
});

// ── uniqueAgentsByName ───────────────────────────────────────────────────────

describe("uniqueAgentsByName", () => {
	it("should deduplicate by name", () => {
		const agents = [mkAgent("a"), mkAgent("b"), mkAgent("a")];
		expect(uniqueAgentsByName(agents)).toHaveLength(2);
	});

	it("should keep first occurrence", () => {
		const agents = [mkAgent("a", "first"), mkAgent("a", "second")];
		expect(uniqueAgentsByName(agents)[0].description).toBe("first");
	});

	it("should handle empty array", () => {
		expect(uniqueAgentsByName([])).toEqual([]);
	});
});

// ── matchSubCommandAgent ─────────────────────────────────────────────────────

describe("matchSubCommandAgent", () => {
	it("should match exact name", () => {
		const result = matchSubCommandAgent(STANDARD_AGENTS, "worker");
		expect(result.matchedAgent?.name).toBe("worker");
		expect(result.ambiguousAgents).toHaveLength(0);
	});

	it("should match prefix", () => {
		const result = matchSubCommandAgent(STANDARD_AGENTS, "wor");
		expect(result.matchedAgent?.name).toBe("worker");
	});

	it("should match case-insensitively", () => {
		const result = matchSubCommandAgent(STANDARD_AGENTS, "WORKER");
		expect(result.matchedAgent?.name).toBe("worker");
	});

	it("should return ambiguous for ambiguous prefix", () => {
		// "ver" matches "verifier" only (prefix), not "reviewer" (contains)
		const result = matchSubCommandAgent(STANDARD_AGENTS, "ver");
		expect(result.matchedAgent?.name).toBe("verifier");
	});

	it("should return empty for no match", () => {
		const result = matchSubCommandAgent(STANDARD_AGENTS, "xyz123");
		expect(result.matchedAgent).toBeUndefined();
		expect(result.ambiguousAgents).toHaveLength(0);
	});

	it("should return empty for empty token", () => {
		const result = matchSubCommandAgent(STANDARD_AGENTS, "");
		expect(result.matchedAgent).toBeUndefined();
		expect(result.ambiguousAgents).toHaveLength(0);
	});

	it("should match initials", () => {
		const agents = [mkAgent("code-reviewer")];
		const result = matchSubCommandAgent(agents, "cr");
		expect(result.matchedAgent?.name).toBe("code-reviewer");
	});

	it("should match contains as last resort", () => {
		const result = matchSubCommandAgent(STANDARD_AGENTS, "ork");
		expect(result.matchedAgent?.name).toBe("worker");
	});
});

// ── getSubCommandAgentCompletions ────────────────────────────────────────────

describe("getSubCommandAgentCompletions", () => {
	it("should return completions for prefix", () => {
		const result = getSubCommandAgentCompletions(STANDARD_AGENTS, "w");
		expect(result).not.toBeNull();
		expect(result?.some((c) => c.label === "worker")).toBe(true);
	});

	it("should return all agents for empty prefix", () => {
		const result = getSubCommandAgentCompletions(STANDARD_AGENTS, "");
		expect(result).not.toBeNull();
		expect(result?.length).toBe(STANDARD_AGENTS.length);
	});

	it("should return null if prefix contains space (already past agent name)", () => {
		const result = getSubCommandAgentCompletions(STANDARD_AGENTS, "worker task");
		expect(result).toBeNull();
	});

	it("should return null for no matches", () => {
		const result = getSubCommandAgentCompletions(STANDARD_AGENTS, "xyz123");
		expect(result).toBeNull();
	});
});

// ── computeAgentAliasHints ───────────────────────────────────────────────────

describe("computeAgentAliasHints", () => {
	it("should compute shortcuts for standard agents", () => {
		const hints = computeAgentAliasHints(STANDARD_AGENTS);
		// Each agent should appear in the hints
		for (const agent of STANDARD_AGENTS) {
			expect(hints).toContain(agent.name);
		}
	});

	it("should include arrows for shortened aliases", () => {
		const hints = computeAgentAliasHints(STANDARD_AGENTS);
		expect(hints).toContain("→");
	});

	it("should handle single agent", () => {
		const hints = computeAgentAliasHints([mkAgent("worker")]);
		expect(hints).toContain("worker");
	});

	it("should handle empty list", () => {
		expect(computeAgentAliasHints([])).toBe("");
	});
});
