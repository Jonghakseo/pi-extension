import { listPersistentMemories, memoryTierRank, type SearchResult } from "./storage.ts";

const MAX_LINES = 200;

/**
 * Build the memory prompt injected into the system prompt every turn.
 * Accessible entries are ordered profile, log, note before the line budget is
 * applied, while query recall still decides relevance independently.
 */
export async function buildMemoryPrompt(projectId?: string, agentEntries: SearchResult[] = []): Promise<string | null> {
	const entries = [...(await listPersistentMemories(projectId)), ...agentEntries].sort(
		(a, b) =>
			memoryTierRank(a.tier) - memoryTierRank(b.tier) ||
			a.scope.localeCompare(b.scope) ||
			a.topic.localeCompare(b.topic) ||
			a.title.localeCompare(b.title),
	);
	if (!entries.length) return null;

	const lines = ["# Memory Index"];
	for (const entry of entries) {
		lines.push(`- [${entry.scope}/${entry.tier}] ${entry.topic}/${entry.title}`);
	}
	if (lines.length > MAX_LINES) {
		lines.splice(MAX_LINES);
		lines.push("... (truncated, use recall for full details)");
	}

	return [
		"",
		"",
		"[Memory Layer]",
		lines.join("\n"),
		"Recall returns profile memories before log and note, while keeping only query matches.",
		"Use recall({ query }) to search, then recall({ id }) for full content. Filters accept scope and tier.",
		"When storing, reuse a listed topic where possible. New memories default to tier 'profile'.",
	].join("\n");
}
