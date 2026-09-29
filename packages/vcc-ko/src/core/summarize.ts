import type { Message } from "@earendil-works/pi-ai";
import { type CommitInfo, extractCommits, mergeCommits, parseCommitSection, readCommits } from "../extract/commits.ts";
import {
	extractFileActivity,
	type FileActivity,
	mergeFileActivity,
	type PathDisplayOptions,
	parseFileActivitySection,
	readFileActivity,
} from "../extract/files.ts";
import { extractGoals } from "../extract/goals.ts";
import { dedupPreferencesAgainstGoals, extractPreferences } from "../extract/preferences.ts";
import type { CompactionMessage, FileOps, SourceRef } from "../types.ts";
import { buildSections } from "./build-sections.ts";
import { filterNoise } from "./filter-noise.ts";
import {
	BRIEF_HEADER_RE,
	BRIEF_MAX_LINES,
	capBrief,
	formatSummary,
	RECALL_NOTE,
	stripRecallNotes,
	unwrapHeaderLines,
	wrapLongLines,
} from "./format.ts";
import { normalize } from "./normalize.ts";
import { type BriefRankingOptions, selectRankedBriefBlocks } from "./rank.ts";
import { builtinRules, type DenoiseRules } from "./rules.ts";

/**
 * Cumulative state persisted in compaction details (`details.state`) so the
 * next compaction merges files and commits exactly instead of re-parsing the
 * wrapped summary text.
 */
export interface CompactionState {
	files: FileActivity;
	commits: CommitInfo[];
}

export interface CompileInput<T extends CompactionMessage = Message> {
	messages: T[];
	/** Actual user messages from the selected lineage, including earlier compactions. */
	userMessages?: Message[];
	/** Recall refs parallel to `userMessages`; rendered on request lines. Omitted → no refs. */
	userSourceIndices?: Array<SourceRef | undefined>;
	previousSummary?: string;
	/** Structured state of the previous compaction; preferred over parsing its text. */
	previousState?: CompactionState;
	/** How file paths are shortened in [Files And Changes] (session cwd, home). */
	pathDisplay?: PathDisplayOptions;
	fileOps?: FileOps;
	/**
	 * Recall ref per message position (`#N` index or `cN` for custom messages,
	 * see src/core/global-indices.ts). Parallel to `messages`; a missing entry
	 * renders as no ref (fail-closed). Omitted entirely → legacy positional.
	 */
	sourceIndices?: Array<SourceRef | undefined>;
	/** 주입형 디노이즈 규칙. 생략 시 내장 규칙 세트. */
	rules?: DenoiseRules;
}

export interface RankedCompileInput extends CompileInput<CompactionMessage> {
	ranking?: BriefRankingOptions;
}

export interface CompileResult {
	summary: string;
	state: CompactionState;
}

export const SUMMARY_HEADERS = [
	"Session Goal",
	"Files And Changes",
	"Commits",
	"Outstanding Context",
	"User Preferences",
] as const;

const SEPARATOR = "\n\n---\n\n";
const HEADER_LINE_RE = new RegExp(`^\\[(?:${SUMMARY_HEADERS.join("|")})\\]$`);

/**
 * Split a note-stripped summary into its header block and brief transcript.
 * A summary without header sections is all brief (the old briefOf() returned
 * "" there and silently dropped the whole previous brief).
 */
const splitSummary = (text: string): { header: string; brief: string } => {
	const t = text.trim();
	if (!HEADER_LINE_RE.test(t.split("\n", 1)[0] ?? "")) return { header: "", brief: t };
	const idx = t.indexOf(SEPARATOR);
	if (idx < 0) return { header: t, brief: "" };
	return { header: t.slice(0, idx), brief: t.slice(idx + SEPARATOR.length).trim() };
};

/** A named section of a header block, from its `[Name]` line to the next header line. */
const sectionOf = (header: string, name: string): string => {
	const lines = header.split("\n");
	const start = lines.indexOf(`[${name}]`);
	if (start < 0) return "";
	let end = start + 1;
	while (end < lines.length && !HEADER_LINE_RE.test(lines[end])) end++;
	return lines.slice(start, end).join("\n").trim();
};

/** Section names present in a rendered summary (for compaction details). */
export const summarySections = (summary: string): string[] => {
	const { header, brief } = splitSummary(stripRecallNotes(summary));
	const names: string[] = SUMMARY_HEADERS.filter((name) => sectionOf(header, name) !== "");
	if (brief) names.push("Brief Transcript");
	return names;
};

/** Validate `details.state` read back from a session file. */
export const readCompactionState = (raw: unknown): CompactionState | undefined => {
	if (!raw || typeof raw !== "object") return undefined;
	const files = readFileActivity((raw as { files?: unknown }).files);
	const commits = readCommits((raw as { commits?: unknown }).commits);
	return files && commits ? { files, commits } : undefined;
};

/** Merge Session Goal / User Preferences lines when intent is not rebuilt from user entries. */
const mergeIntentSection = (name: string, prev: string, fresh: string): string => {
	if (!prev) return fresh;
	if (!fresh) return prev;
	const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
	const prevLines = unwrapHeaderLines(prev).filter(isClean);
	const freshLines = unwrapHeaderLines(fresh).filter(isClean);
	const combined = [...new Set([...prevLines, ...freshLines])];
	const cap = name === "Session Goal" ? 8 : 15;
	const capped = combined.length > cap ? combined.slice(-cap) : combined;
	if (capped.length === 0) return "";
	return `[${name}]\n${capped.join("\n")}`;
};

const mergeBriefTranscript = (prev: string, fresh: string): string => {
	if (!prev) return fresh;
	if (!fresh) return prev;
	return `${prev}\n\n${fresh}`;
};

const briefLineCount = (text: string): number => (text ? text.split("\n").length : 0);

const capBriefToLineBudget = (text: string, maxLines: number): string => {
	if (!text || maxLines <= 0) return "";
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const kept = lines.slice(-maxLines);
	const firstHeader = kept.findIndex((l) => BRIEF_HEADER_RE.test(l));
	const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
	const omitted = lines.length - clean.length;
	return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

// The fresh brief is ranked and uncapped, so on long windows it used to leave
// the previous brief zero lines: the narrative right before this window, or a
// foreign (LLM) previous summary as a whole, vanished. Keep at least its tail.
const MIN_PREVIOUS_BRIEF_LINES = 20;

const mergeBriefTranscriptWithFreshBudget = (prev: string, fresh: string): string => {
	if (!prev) return fresh;
	if (!fresh) return capBrief(prev);
	const freshLines = briefLineCount(fresh);
	const remainingPrevLines = Math.max(MIN_PREVIOUS_BRIEF_LINES, BRIEF_MAX_LINES - freshLines);
	const prevTail = capBriefToLineBudget(prev, remainingPrevLines);
	return prevTail ? `${prevTail}\n\n${fresh}` : fresh;
};

const mergePrevious = (
	prev: string,
	fresh: string,
	options: { preserveFreshBrief?: boolean; rebuildIntent?: boolean } = {},
): string => {
	const p = splitSummary(prev);
	const f = splitSummary(fresh);
	const headers = SUMMARY_HEADERS.map((name) => {
		const freshSec = sectionOf(f.header, name);
		if (name === "Session Goal" || name === "User Preferences") {
			return options.rebuildIntent ? freshSec : mergeIntentSection(name, sectionOf(p.header, name), freshSec);
		}
		// Files And Changes and Commits are rendered from the merged cumulative
		// state; Outstanding Context is volatile. All three come from `fresh`.
		return freshSec;
	}).filter(Boolean);

	const mergedBrief = options.preserveFreshBrief
		? mergeBriefTranscriptWithFreshBudget(p.brief, f.brief)
		: mergeBriefTranscript(p.brief, f.brief);

	const parts: string[] = [];
	if (headers.length > 0) parts.push(headers.join("\n\n"));
	if (mergedBrief) parts.push(options.preserveFreshBrief ? mergedBrief : capBrief(mergedBrief));
	return parts.join(SEPARATOR);
};

interface CompileWithBriefBlocksOptions {
	briefBlocksFor?: (blocks: ReturnType<typeof normalize>) => ReturnType<typeof normalize>;
	capFreshBrief?: boolean;
	preserveFreshBriefOnMerge?: boolean;
}

const compileWithBriefBlocks = (
	input: CompileInput<CompactionMessage>,
	options: CompileWithBriefBlocksOptions = {},
): CompileResult => {
	const rules = input.rules ?? builtinRules();
	const blocks = filterNoise(normalize(input.messages, input.sourceIndices), rules);
	const briefBlocks = options.briefBlocksFor?.(blocks);

	// Strip every recall note (current, legacy, wrapped) so the merge never
	// re-embeds an old note inside the brief.
	const prev = input.previousSummary ? stripRecallNotes(input.previousSummary) : undefined;
	const prevHeader = prev ? splitSummary(prev).header : "";
	// Files and commits are cumulative: the previous state (or, for summaries
	// written without one, its wrap-aware parsed text) plus this window.
	const state: CompactionState = {
		files: mergeFileActivity(
			input.previousState?.files ?? parseFileActivitySection(sectionOf(prevHeader, "Files And Changes")),
			extractFileActivity(blocks, input.fileOps),
		),
		commits: mergeCommits(
			input.previousState?.commits ?? parseCommitSection(sectionOf(prevHeader, "Commits")),
			extractCommits(blocks),
		),
	};

	const data = buildSections({
		blocks,
		briefBlocks,
		fileOps: input.fileOps,
		rules,
		files: state.files,
		commits: state.commits,
		pathDisplay: input.pathDisplay,
	});
	// Recover intent from original user entries, including goals displaced by
	// legacy summaries that misclassified synthetic messages as user messages.
	if (input.userMessages) {
		// No refs unless the caller maps user entries into the recall index space:
		// positional numbers would point at the wrong messages.
		const userRefs = input.userSourceIndices ?? input.userMessages.map(() => undefined);
		const userBlocks = filterNoise(normalize(input.userMessages, userRefs), rules);
		data.sessionGoal = extractGoals(userBlocks, rules);
		data.userPreferences = dedupPreferencesAgainstGoals(extractPreferences(userBlocks, rules), data.sessionGoal);
	}

	const fresh = formatSummary(data, {
		capBriefTranscript: options.capFreshBrief ?? true,
	});
	const merged = prev
		? mergePrevious(prev, fresh, {
				preserveFreshBrief: options.preserveFreshBriefOnMerge,
				rebuildIntent: input.userMessages !== undefined,
			})
		: fresh;
	if (!merged) return { summary: "", state };
	return { summary: wrapLongLines(merged + SEPARATOR + RECALL_NOTE), state };
};

export const compile = (input: CompileInput<CompactionMessage>): string => compileWithBriefBlocks(input).summary;

export const compileRankedWithState = (input: RankedCompileInput): CompileResult =>
	compileWithBriefBlocks(input, {
		briefBlocksFor: (blocks) =>
			selectRankedBriefBlocks(blocks, {
				...input.ranking,
				fileOps: input.ranking?.fileOps ?? input.fileOps,
			}),
		capFreshBrief: false,
		preserveFreshBriefOnMerge: true,
	});

export const compileRanked = (input: RankedCompileInput): string => compileRankedWithState(input).summary;
