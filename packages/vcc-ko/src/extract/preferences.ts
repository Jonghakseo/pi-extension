import { clip, nonEmptyLines } from "../core/content.ts";
import { builtinRules, type DenoiseRules } from "../core/rules.ts";
import { hasSecretToken } from "../core/secrets.ts";
import { collapseSkillLines } from "../core/skill-collapse.ts";
import type { NormalizedBlock } from "../types.ts";

// A user message often states two standing constraints at once ("delegate code
// edits to workers", "don't ask me"); more than that is usually a pasted rule list.
const PREFS_PER_BLOCK = 2;
const MAX_PREFERENCES = 10;

// Double-quoted text is a mention or an example ("사이드에 위임해줘" 같은 트리거 문구),
// not the user's own instruction. Single quotes are left alone: they double as
// apostrophes ("don't").
const QUOTED_SPAN_RE = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g;

export const extractPreferences = (blocks: NormalizedBlock[], rules: DenoiseRules = builtinRules()): string[] => {
	const prefs: string[] = [];

	for (const b of blocks) {
		if (b.kind !== "user") continue;

		let perBlock = 0;
		// 스킬 본문은 사용자 선호가 아니므로 접어서 제외한다 (goals와 동일 취급).
		// 한국어 패턴은 스킬 매뉴얼 문장(“반드시 먼저 실행한다” 등)과도 일치하므로
		// 접지 않으면 스킬 내용 전체가 선호로 새는 문제가 있었다.
		for (const line of collapseSkillLines(nonEmptyLines(b.text))) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.length < 5) continue;
			if (trimmed.length > 200) continue;
			// Reject questions.
			if (trimmed.endsWith("?") || trimmed.includes("?...")) continue;
			const unquoted = trimmed.replace(QUOTED_SPAN_RE, " ");
			if (!rules.preferencePatterns.some((p) => p.test(unquoted))) continue;
			if (hasSecretToken(trimmed)) continue;

			const clipped = clip(trimmed, 200);
			// A repeated preference counts as recent: move it to the end.
			const key = clipped.toLowerCase();
			const existing = prefs.findIndex((p) => p.toLowerCase() === key);
			if (existing >= 0) prefs.splice(existing, 1);
			prefs.push(clipped);

			// Cap per user block to avoid pasting long rule lists as many prefs.
			if (++perBlock >= PREFS_PER_BLOCK) break;
		}
	}

	// Newest win. Preferences are rebuilt from every user entry at each
	// compaction, so keeping the oldest ten froze the section for the rest of a
	// long session and later instructions never appeared.
	return prefs.slice(-MAX_PREFERENCES);
};

/**
 * Remove preferences that duplicate goals (case-insensitive, trimmed).
 * Called by `buildSections` so that the two sections do not overlap.
 */
export const dedupPreferencesAgainstGoals = (prefs: string[], goals: string[]): string[] => {
	// Request lines carry a trailing recall ref such as " (#12)"; compare without it.
	const norm = (s: string) =>
		s
			.replace(/\s*\(#c?\d+\)$/, "")
			.trim()
			.toLowerCase();
	const goalSet = new Set(goals.map(norm));
	return prefs.filter((p) => !goalSet.has(norm(p)));
};
