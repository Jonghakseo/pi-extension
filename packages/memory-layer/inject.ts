import { readMemoryMd } from "./storage.ts";

const MAX_LINES = 200;

/**
 * Build the memory prompt injected into systemPrompt every turn.
 *
 * Strategy (Claude Code style):
 *   - Read user/MEMORY.md + project/MEMORY.md (index files)
 *   - If combined ≤ 200 lines → inject full index
 *   - If > 200 lines → truncate with hint to use recall
 *
 * The index already contains every memory title grouped by topic,
 * so the LLM knows what's available without needing a separate recall call.
 */
export async function buildMemoryPrompt(projectId?: string): Promise<string | null> {
	const userIndex = (await readMemoryMd("user")).trim();
	const projectIndex = projectId ? (await readMemoryMd("project", projectId)).trim() : "";

	if (!userIndex && !projectIndex) return null;

	const parts: string[] = [];

	if (userIndex) {
		parts.push("[User Memory]");
		parts.push(userIndex);
	}

	if (projectIndex) {
		if (parts.length) parts.push("");
		parts.push("[Project Memory]");
		parts.push(projectIndex);
	}

	let lines = parts.join("\n").split("\n");

	if (lines.length > MAX_LINES) {
		lines = lines.slice(0, MAX_LINES);
		lines.push("... (truncated — use recall tool for full details)");
	}

	return [
		"",
		"",
		"[Memory Layer]",
		lines.join("\n"),
		"상세 내용은 recall({ query })로 검색 후, 결과의 ID로 recall({ id })를 호출하면 볼 수 있습니다.",
	].join("\n");
}
