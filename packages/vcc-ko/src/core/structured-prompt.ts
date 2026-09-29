/**
 * Structured prompts: long user messages split into bracketed upper-case
 * sections, e.g.
 *
 *   [GENERAL INSTRUCTION — AUTHORITATIVE]
 *   [HISTORY — REFERENCE ONLY]
 *   [REQUEST — AUTHORITATIVE]
 *
 * Delegation harnesses wrap the real task this way and put the task LAST. Read
 * as plain text, the wrapper boilerplate and the quoted parent conversation
 * became the [Session Goal] of a subagent session (and the actual request at
 * line 140 of 142 was never reached). The rule is a general document shape,
 * not a specific tool's wording: keep the request section (plus any text
 * before the first marker) when one exists, otherwise drop sections declared
 * as reference material.
 */

// A line holding only a bracketed upper-case title, optionally "TITLE — QUALIFIER".
const MARKER_RE = /^\s*\[([A-Z][A-Z0-9 _/&-]{1,40}?)(?:\s*[—–-]{1,2}\s*([A-Z][A-Z0-9 _/&-]{1,40}?))?\]\s*$/;
const REQUEST_TITLE_RE = /\b(?:REQUEST|TASK|ASK|GOAL)S?\b/;
const REFERENCE_TITLE_RE = /\b(?:REFERENCE|HISTORY|TRANSCRIPT|BACKGROUND|SOURCE)\b/;

/** Short messages are left alone: the shape only matters for injected wrappers. */
const MIN_STRUCTURED_CHARS = 1200;

interface Section {
	title: string;
	markerLine: number;
	start: number;
	end: number;
}

export const focusStructuredPrompt = (text: string): string => {
	if (text.length < MIN_STRUCTURED_CHARS) return text;
	const lines = text.split("\n");
	const markers: Array<{ line: number; title: string }> = [];
	lines.forEach((line, i) => {
		const m = MARKER_RE.exec(line);
		if (m) markers.push({ line: i, title: [m[1], m[2]].filter(Boolean).join(" — ") });
	});
	if (markers.length < 2) return text;

	const sections: Section[] = markers.map((m, k) => ({
		title: m.title,
		markerLine: m.line,
		start: m.line + 1,
		end: k + 1 < markers.length ? markers[k + 1].line : lines.length,
	}));

	const requests = sections.filter((s) => REQUEST_TITLE_RE.test(s.title) && !REFERENCE_TITLE_RE.test(s.title));
	if (requests.length > 0) {
		// Text before the first marker is what the sender wrote around a pasted
		// document (typically the user's own instruction), never reference material.
		const preamble = lines.slice(0, markers[0].line).join("\n").trim();
		const focused = [preamble, ...requests.map((s) => lines.slice(s.start, s.end).join("\n").trim())]
			.filter(Boolean)
			.join("\n");
		return focused || text;
	}

	const reference = sections.filter((s) => REFERENCE_TITLE_RE.test(s.title));
	if (reference.length === 0) return text;
	const dropped = (i: number) => reference.some((s) => i >= s.markerLine && i < s.end);
	const kept = lines
		.filter((_, i) => !dropped(i))
		.join("\n")
		.trim();
	return kept || text;
};
