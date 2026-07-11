/**
 * Pure utility functions extracted from subagent/agents.ts and subagent/runner.ts.
 * These handle agent discovery helpers, normalization, matching, and alias computation.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentConfigLike {
	name: string;
	description: string;
	source: string;
	tools?: string[];
	model?: string;
}

export interface AgentAliasMatch<T extends AgentConfigLike = AgentConfigLike> {
	matchedAgent?: T;
	ambiguousAgents: T[];
}

export const AGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

// ── Constants ────────────────────────────────────────────────────────────────

export const CLAUDE_TOOL_MAP: Record<string, string | undefined> = {
	bash: "bash",
	read: "read",
	edit: "edit",
	write: "write",
	grep: "grep",
	glob: "find",
	ls: "ls",
	todowrite: "todo",
	todoread: "todo",
	skill: undefined,
};

export const PI_TO_CLAUDE_TOOL_MAP: Record<string, string> = {
	read: "Read",
	find: "Glob",
	grep: "Grep",
	bash: "Bash",
	edit: "Edit",
	write: "Write",
	ls: "LS",
};

export function mapPiToolsToClaude(piTools: string[]): string[] {
	const mapped: string[] = [];
	for (const tool of piTools) {
		const claudeTool = PI_TO_CLAUDE_TOOL_MAP[tool];
		if (!claudeTool) {
			throw new Error(
				`Unsupported tool "${tool}" for Claude runtime. Supported tools: ${Object.keys(PI_TO_CLAUDE_TOOL_MAP).join(", ")}`,
			);
		}
		mapped.push(claudeTool);
	}
	return Array.from(new Set(mapped));
}

export function isClaudeModel(model: string | undefined): boolean {
	if (!model) return false;
	const lower = model.toLowerCase();
	return lower.startsWith("anthropic/claude-") || lower.startsWith("claude-");
}

export function validateClaudeRuntimeModel(model: string | undefined): void {
	if (!model) return;
	if (isClaudeModel(model)) return;
	throw new Error(
		`Model "${model}" is not supported with Claude runtime. Only Anthropic models (anthropic/claude-* or claude-*) are allowed.`,
	);
}

export const CLAUDE_MODEL_ALIAS_MAP: Record<string, string> = {
	opus: "claude-opus-4-7",
	sonnet: "claude-sonnet-5",
	haiku: "claude-haiku-4-5",
};

// ── Tool / Model / Thinking Normalization ───────────────────────────────────

/**
 * Normalize a comma-separated tool list according to the given format.
 * For "claude" format, maps Claude tool names to pi equivalents.
 */
export function normalizeTools(rawTools: string | undefined, format: "pi" | "claude"): string[] | undefined {
	if (!rawTools) return undefined;

	const parsed = rawTools
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	if (parsed.length === 0) return undefined;
	if (format === "pi") return parsed;

	const mapped = parsed
		.map((tool) => CLAUDE_TOOL_MAP[tool.toLowerCase()] ?? undefined)
		.filter((tool): tool is string => Boolean(tool));

	if (mapped.length === 0) return undefined;
	return Array.from(new Set(mapped));
}

/**
 * Normalize a model reference according to the given format.
 * For "claude" format, maps short aliases (opus, sonnet, haiku) to full model names.
 */
export function normalizeModel(rawModel: string | undefined, format: "pi" | "claude"): string | undefined {
	if (!rawModel) return undefined;
	const model = rawModel.trim();
	if (!model) return undefined;

	if (format === "claude") {
		if (model.includes("/")) return model;
		return CLAUDE_MODEL_ALIAS_MAP[model.toLowerCase()] ?? model;
	}

	return model;
}

/**
 * Normalize and validate thinking level.
 */
export function normalizeThinkingLevel(rawThinking: string | undefined): AgentThinkingLevel | undefined {
	if (!rawThinking) return undefined;
	const thinking = rawThinking.trim().toLowerCase();
	if (!thinking) return undefined;
	if ((AGENT_THINKING_LEVELS as readonly string[]).includes(thinking)) return thinking as AgentThinkingLevel;
	return undefined;
}

// ── Agent Alias / Initials ───────────────────────────────────────────────────

/**
 * Normalize an agent alias by lowercasing and removing non-alphanumeric chars.
 */
export function normalizeAgentAlias(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Extract initials from agent name parts.
 * "worker" → "w", "code-reviewer" → "cr"
 */
export function getAgentInitials(name: string): string {
	return name
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map((part) => part[0])
		.join("");
}

/**
 * Deduplicate agents by name, keeping the first occurrence.
 */
export function uniqueAgentsByName<T extends { name: string }>(candidates: T[]): T[] {
	const map = new Map<string, T>();
	for (const agent of candidates) {
		if (!map.has(agent.name)) map.set(agent.name, agent);
	}
	return Array.from(map.values());
}

// ── Agent Matching ───────────────────────────────────────────────────────────

/**
 * Match a user-supplied token against a list of agents using fuzzy matching.
 * Priority: exact match → prefix match → initials match → contains match.
 */
export function matchSubCommandAgent<T extends AgentConfigLike>(agents: T[], token: string): AgentAliasMatch<T> {
	const raw = token.trim().toLowerCase();
	if (!raw) return { ambiguousAgents: [] };

	const normalized = normalizeAgentAlias(raw);

	// Exact match
	const exact = uniqueAgentsByName(
		agents.filter((agent) => {
			const name = agent.name.toLowerCase();
			if (name === raw) return true;
			if (normalized && normalizeAgentAlias(name) === normalized) return true;
			return false;
		}),
	);
	if (exact.length === 1) return { matchedAgent: exact[0], ambiguousAgents: [] };
	if (exact.length > 1) return { ambiguousAgents: exact };

	// Prefix match
	const prefix = uniqueAgentsByName(
		agents.filter((agent) => {
			const name = agent.name.toLowerCase();
			const nameNormalized = normalizeAgentAlias(name);
			const parts = name.split(/[^a-z0-9]+/).filter(Boolean);
			if (name.startsWith(raw)) return true;
			if (normalized && nameNormalized.startsWith(normalized)) return true;
			if (parts.some((part) => part.startsWith(raw))) return true;
			if (normalized && parts.some((part) => normalizeAgentAlias(part).startsWith(normalized))) return true;
			return false;
		}),
	);
	if (prefix.length === 1) return { matchedAgent: prefix[0], ambiguousAgents: [] };
	if (prefix.length > 1) return { ambiguousAgents: prefix };

	// Initials match
	const initialsMatch = uniqueAgentsByName(
		agents.filter((agent) => {
			const agentInitials = getAgentInitials(agent.name);
			return normalized === agentInitials;
		}),
	);
	if (initialsMatch.length === 1) return { matchedAgent: initialsMatch[0], ambiguousAgents: [] };
	if (initialsMatch.length > 1) return { ambiguousAgents: initialsMatch };

	// Contains match
	const contains = uniqueAgentsByName(
		agents.filter((agent) => {
			const name = agent.name.toLowerCase();
			const nameNormalized = normalizeAgentAlias(name);
			if (name.includes(raw)) return true;
			if (normalized && nameNormalized.includes(normalized)) return true;
			return false;
		}),
	);
	if (contains.length === 1) return { matchedAgent: contains[0], ambiguousAgents: [] };
	if (contains.length > 1) return { ambiguousAgents: contains };

	return { ambiguousAgents: [] };
}

/**
 * Get tab-completion candidates for an agent name prefix.
 */
export function getSubCommandAgentCompletions<T extends AgentConfigLike>(
	agents: T[],
	argumentPrefix: string,
): { value: string; label: string; description?: string }[] | null {
	const trimmedStart = argumentPrefix.trimStart();
	if (trimmedStart.includes(" ")) return null;

	const raw = trimmedStart.toLowerCase();
	const normalized = normalizeAgentAlias(raw);

	const scored = agents
		.map((agent) => {
			const name = agent.name.toLowerCase();
			const nameNormalized = normalizeAgentAlias(name);
			const parts = name.split(/[^a-z0-9]+/).filter(Boolean);
			const agentInitials = getAgentInitials(name);

			let score = Number.POSITIVE_INFINITY;
			if (!raw) score = 100;
			else if (name === raw || (normalized && nameNormalized === normalized)) score = 0;
			else if (name.startsWith(raw) || (normalized && nameNormalized.startsWith(normalized))) score = 1;
			else if (
				parts.some((part) => part.startsWith(raw)) ||
				(normalized && parts.some((part) => normalizeAgentAlias(part).startsWith(normalized)))
			)
				score = 2;
			else if (normalized && agentInitials === normalized) score = 3;
			else if (name.includes(raw) || (normalized && nameNormalized.includes(normalized))) score = 4;

			return { agent, score };
		})
		.filter((row) => Number.isFinite(row.score))
		.sort((a, b) => a.score - b.score || a.agent.name.localeCompare(b.agent.name))
		.slice(0, 20)
		.map(({ agent }) => ({
			value: `${agent.name} `,
			label: agent.name,
			description: agent.description || `[${agent.source}]`,
		}));

	return scored.length > 0 ? scored : null;
}

/**
 * Compute shortest usable alias for each agent and return a formatted hint string.
 * e.g. "w→worker  s→searcher  r→reviewer  v→verifier"
 */
export function computeAgentAliasHints<T extends AgentConfigLike>(agents: T[]): string {
	const hints: string[] = [];

	for (const agent of agents) {
		const name = agent.name.toLowerCase();
		const initials = getAgentInitials(name);

		let shortestAlias = name;
		for (let i = 1; i <= name.length; i++) {
			const candidate = name.slice(0, i);
			const result = matchSubCommandAgent(agents, candidate);
			if (result.matchedAgent?.name === agent.name) {
				shortestAlias = candidate;
				break;
			}
		}

		if (initials.length >= 2 && initials.length <= shortestAlias.length) {
			const result = matchSubCommandAgent(agents, initials);
			if (result.matchedAgent?.name === agent.name) {
				shortestAlias = initials;
			}
		}

		hints.push(shortestAlias === name ? name : `${shortestAlias}→${name}`);
	}

	return hints.join("  ");
}
