import type { SectionData } from "../sections.ts";

const section = (title: string, items: string[]): string => {
	if (items.length === 0) return "";
	const body = items.map((i) => `- ${i}`).join("\n");
	return `[${title}]\n${body}`;
};

export const BRIEF_MAX_LINES = 120;
export const TUI_SAFE_LINE_CHARS = 120;

/**
 * A real brief section header line. Content lines can also start with `[`
 * (`[bash_async id] ...`, markdown links, `[blocked] ...`), so cut points and
 * section counting must match only the headers the brief renderer emits.
 */
export const BRIEF_HEADER_RE = /^\[(?:user|assistant|bash|custom:[^\]\n]+)\]$/;

const wrapLine = (line: string, maxChars: number): string[] => {
	if (line.length <= maxChars) return [line];

	const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
	const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
	const wrapped: string[] = [];
	let remaining = line;
	let prefix = "";

	while (prefix.length + remaining.length > maxChars) {
		const available = Math.max(20, maxChars - prefix.length);
		// A space split must leave the line strictly shorter than maxChars so a
		// full-width line always means a mid-token split (see unwrapHeaderLines).
		let splitAt = remaining.lastIndexOf(" ", available - 1);
		if (splitAt < Math.floor(available * 0.5)) splitAt = available;

		wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
		remaining = remaining.slice(splitAt).trimStart();
		prefix = continuationIndent;
	}

	if (remaining) wrapped.push(prefix + remaining);
	return wrapped;
};

export const wrapLongLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string =>
	text
		.split("\n")
		.flatMap((line) => wrapLine(line, maxChars))
		.join("\n");

/**
 * Whether wrapLine cut this physical line in the middle of a token (so the
 * continuation must be re-joined without a space).
 *
 * wrapLine cuts mid-token only when no space falls in the second half of the
 * chunk, and then the line fills the width exactly. Summaries written before
 * the space-split fix could also fill the width with a split AT a space, so a
 * full-width line counts as a mid-token cut only if it also has no space in its
 * second half (index 64 covers continuation indents up to 8) and does not end
 * with a list comma, which is always followed by a space.
 */
const isMidTokenCut = (line: string, maxChars: number): boolean =>
	line.length >= maxChars && !line.endsWith(",") && !/\s/.test(line.slice(Math.ceil((maxChars + 8) / 2)));

/**
 * Inverse of wrapLongLines for bullet lines of header sections: re-join the
 * indented continuation lines that wrapLine produced for a `- ` line.
 * Merges used to read only the first physical line, silently dropping the
 * rest of long file lists, commit messages and goals.
 */
export const unwrapHeaderLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string[] => {
	const out: string[] = [];
	let lastPhysical = "";
	for (const line of text.split("\n")) {
		const prev = out[out.length - 1];
		if (prev?.startsWith("- ") && /^\s{2,}\S/.test(line)) {
			const joiner = isMidTokenCut(lastPhysical, maxChars) ? "" : " ";
			out[out.length - 1] = `${prev}${joiner}${line.trim()}`;
		} else {
			out.push(line);
		}
		lastPhysical = line;
	}
	return out;
};

export const capBrief = (text: string): string => {
	const lines = text.split("\n");
	if (lines.length <= BRIEF_MAX_LINES) return text;
	const omitted = lines.length - BRIEF_MAX_LINES;
	const kept = lines.slice(-BRIEF_MAX_LINES);
	// Find first section header to avoid cutting mid-section
	const firstHeader = kept.findIndex((l) => BRIEF_HEADER_RE.test(l));
	const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
	return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

/**
 * Trailing pointer to recall. Must stay within TUI_SAFE_LINE_CHARS: a wrapped
 * note could not be found verbatim by stripRecallNotes, and every merge then
 * re-embedded the previous note mid-brief (the pre-fix 127-char note did this).
 */
export const RECALL_NOTE =
	"Use `session_recall` (search terms or #N refs) to recover details from before this summary. Do not redo completed work.";

/** Notes emitted by earlier versions; still stripped from previous summaries. */
const LEGACY_RECALL_NOTES = [
	"Use `vcc_recall` (search terms or #N refs) to recover details from before this summary. Do not redo completed work.",
	"Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.",
];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whitespace-tolerant: wrapLongLines may have split a note across lines (with
// continuation indent), so words are joined by \s+ instead of single spaces.
const notePattern = (note: string): string => note.trim().split(/\s+/).map(escapeRegex).join("\\s+");

const RECALL_NOTE_STRIP_RE = new RegExp(
	`(?:\\n[ \\t]*\\n?[ \\t]*---[ \\t]*\\n)?\\s*(?:${[RECALL_NOTE, ...LEGACY_RECALL_NOTES].map(notePattern).join("|")})`,
	"g",
);

/**
 * Remove every recall note (current or legacy, wrapped or not) together with
 * the `---` separator in front of it. Earlier versions left stale notes inside
 * the brief of merged summaries; stripping all occurrences cleans those up on
 * the next compaction.
 */
export const stripRecallNotes = (text: string): string => text.replace(RECALL_NOTE_STRIP_RE, "").trimEnd();

export interface FormatSummaryOptions {
	capBriefTranscript?: boolean;
}

export const formatSummary = (data: SectionData, options: FormatSummaryOptions = {}): string => {
	const capBriefTranscript = options.capBriefTranscript ?? true;
	const headerParts = [
		section("Session Goal", data.sessionGoal),
		section("Files And Changes", data.filesAndChanges),
		section("Commits", data.commits),
		section("Outstanding Context", data.outstandingContext),
		section("User Preferences", data.userPreferences),
	].filter(Boolean);

	const parts: string[] = [];
	if (headerParts.length > 0) {
		parts.push(headerParts.join("\n\n"));
	}
	if (data.briefTranscript) {
		parts.push(capBriefTranscript ? capBrief(data.briefTranscript) : data.briefTranscript);
	}

	if (parts.length === 0) return "";

	// NOTE: RECALL_NOTE is intentionally NOT appended here.
	// It is appended once by `compile()` at the very end, after merge-with-previous,
	// to avoid the note compounding inside the brief transcript across compactions.
	return wrapLongLines(parts.join("\n\n---\n\n"));
};
