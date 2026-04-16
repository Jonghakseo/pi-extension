import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

// ── Memory Scope ─────────────────────────────────────────────────────────────

export type MemoryScope = "user" | "project";

// ── Tool Parameter Schemas ───────────────────────────────────────────────────

export const RememberParams = Type.Object({
	content: Type.String({
		description: "Content to remember (the fact, rule, or lesson to store in long-term memory)",
	}),
	title: Type.Optional(Type.String({ description: "Short title/summary for the memory (auto-generated if omitted)" })),
	scope: StringEnum(["user", "project"] as const, {
		description:
			"Storage scope. 'user' for personal profile, global preferences, or cross-project rules. " +
			"'project' for repo-specific tech decisions, env, tooling, configs. " +
			"Choose based on whether the information applies globally or only to the current project.",
	}),
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
	scope: Type.Optional(
		StringEnum(["user", "project"] as const, {
			description: "Optional scope filter for recall results (user|project).",
		}),
	),
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
		scope: Type.Optional(
			StringEnum(["user", "project"] as const, {
				description: "Scope to delete from (user|project). If omitted, searches both and errors on ambiguity.",
			}),
		),
	},
	{ description: "Permanently delete a memory entry. This action is irreversible." },
);

export const MemoryListParams = Type.Object({
	scope: Type.Optional(StringEnum(["user", "project"] as const, { description: "Filter by scope" })),
});

// ── Project ID Resolution (unchanged) ────────────────────────────────────────

export type ProjectIdBasis = "remote" | "commit" | "path";

export interface ProjectIdResult {
	id: string;
	basis: ProjectIdBasis;
}
