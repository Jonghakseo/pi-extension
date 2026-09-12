import { Type } from "@sinclair/typebox";

const MemoryScopeSchema = Type.Union([Type.Literal("agent"), Type.Literal("user"), Type.Literal("project")], {
	description:
		"Storage scope. 'agent' is private to the current Pi session, 'user' is personal cross-project memory, and 'project' is repo-specific memory.",
});

const MemoryTierSchema = Type.Union([Type.Literal("profile"), Type.Literal("log"), Type.Literal("note")], {
	description:
		"Importance tier. profile stores lasting facts, preferences, and rules; log stores decisions or history; note stores working or tentative context. Recall prioritizes profile, then log, then note. Defaults to profile; no automatic expiry.",
});

// ── Memory Scope and Tier ───────────────────────────────────────────────────

export type MemoryScope = "agent" | "user" | "project";
export type MemoryTier = "profile" | "log" | "note";

// ── Tool Parameter Schemas ───────────────────────────────────────────────────

export const RememberParams = Type.Object({
	content: Type.String({
		description: "Content to remember (the fact, rule, or lesson to store in memory)",
	}),
	title: Type.Optional(Type.String({ description: "Short title/summary for the memory (auto-generated if omitted)" })),
	scope: MemoryScopeSchema,
	tier: Type.Optional(MemoryTierSchema),
	topic: Type.Optional(
		Type.String({
			description:
				"Topic slug to group this memory under (e.g. 'coding-rules', 'tooling', 'domain'). " +
				"Strongly prefer reusing an existing topic shown in the Memory Layer index; " +
				"only create a new short english slug when the topic is clearly different. " +
				"Omit to default to 'general'.",
		}),
	),
});

export const RecallParams = Type.Object({
	query: Type.Optional(
		Type.String({
			description:
				"Search query (keywords or natural language) to find relevant memories. Returns a summary list with IDs.",
		}),
	),
	id: Type.Optional(
		Type.String({ description: "Memory entry ID for detail lookup. Returns the full content of a specific memory." }),
	),
	scope: Type.Optional(MemoryScopeSchema),
	tier: Type.Optional(MemoryTierSchema),
});

export const ForgetParams = Type.Object(
	{
		topic: Type.Optional(
			Type.String({
				description:
					"Topic filename (e.g. 'coding-rules' or 'coding-rules.md'). Optional when title uniquely identifies a single memory.",
			}),
		),
		title: Type.String({
			description:
				"Title of the memory entry to remove. Exact match is preferred; if topic is omitted, it must resolve to a single memory.",
		}),
		scope: Type.Optional(MemoryScopeSchema),
	},
	{
		description:
			"Remove a memory from active recall. User/project entries are deleted from storage; agent entries are logically deleted and remain in session history.",
	},
);

export const MemoryListParams = Type.Object({
	scope: Type.Optional(MemoryScopeSchema),
	tier: Type.Optional(MemoryTierSchema),
});

// ── Project ID Resolution ────────────────────────────────────────────────────

export type ProjectIdBasis = "remote" | "commit" | "path";

export interface ProjectIdResult {
	id: string;
	basis: ProjectIdBasis;
}
