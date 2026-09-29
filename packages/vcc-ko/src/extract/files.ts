import { homedir } from "node:os";
import { unwrapHeaderLines } from "../core/format.ts";
import { extractPath } from "../core/tool-args.ts";
import type { FileOps, NormalizedBlock } from "../types.ts";

/**
 * Cumulative file activity. Each list is ordered oldest → most recently touched,
 * holds one spelling per file, and keeps raw (untrimmed) paths so later merges
 * compare exactly. Display trimming happens only in renderFileActivity.
 */
export interface FileActivity {
	modified: string[];
	created: string[];
	read: string[];
}

/** Paths kept per list in persisted state (newest win). */
export const FILE_ACTIVITY_STORE_LIMIT = 100;
/** Paths shown per list in the summary (newest win). */
export const FILE_ACTIVITY_DISPLAY_LIMIT = 10;

// Tool names are matched case-insensitively, mirroring the /i regexes in
// core/rank.ts. Entries must be lowercase.
const FILE_READ_TOOLS = new Set(["read", "read_file", "view"]);

// Multi-file patch tools (apply_patch) carry their paths inside the diff payload,
// not in a path arg, so extractPath yields nothing for them; those files are
// recovered from the hook-provided fileOps.
const FILE_WRITE_TOOLS = new Set([
	"edit",
	"write",
	"edit_file",
	"write_file",
	"multiedit",
	"quick_edit",
	"target_edit",
	"apply_patch",
]);

const FILE_CREATE_TOOLS = new Set(["write", "write_file"]);

const CATEGORIES = ["modified", "created", "read"] as const;

export const emptyFileActivity = (): FileActivity => ({ modified: [], created: [], read: [] });

/**
 * Two spellings of one file: identical, or one absolute path ending with the
 * other relative path. Summaries before structured state stored paths with a
 * common prefix trimmed, so a legacy `src/a.ts` must merge with `/repo/src/a.ts`.
 */
const sameFile = (a: string, b: string): boolean => {
	if (a === b) return true;
	const aAbs = a.startsWith("/");
	if (aAbs === b.startsWith("/")) return false;
	return aAbs ? a.endsWith(`/${b}`) : b.endsWith(`/${a}`);
};

/** Move `path` to the most-recent end, replacing any other spelling of the same file. */
const touch = (list: string[], path: string): void => {
	for (let i = list.length - 1; i >= 0; i--) {
		if (sameFile(list[i], path)) list.splice(i, 1);
	}
	list.push(path);
};

const newest = (list: string[], limit: number): string[] => (list.length > limit ? list.slice(-limit) : list);

/**
 * File activity of one summarized window. Hook-provided fileOps come first
 * (pi-core collects them in message order); tool calls then re-touch the files
 * they name in chronological order, so the list ends with the latest work.
 */
export const extractFileActivity = (blocks: NormalizedBlock[], fileOps?: FileOps): FileActivity => {
	const act = emptyFileActivity();
	for (const p of fileOps?.readFiles ?? []) if (p) touch(act.read, p);
	for (const p of fileOps?.modifiedFiles ?? []) if (p) touch(act.modified, p);
	for (const p of fileOps?.createdFiles ?? []) if (p) touch(act.created, p);

	for (const b of blocks) {
		if (b.kind !== "tool_call") continue;
		const p = extractPath(b.args);
		if (!p) continue;
		const name = b.name.toLowerCase();
		if (FILE_READ_TOOLS.has(name)) touch(act.read, p);
		if (FILE_WRITE_TOOLS.has(name)) touch(act.modified, p);
		if (FILE_CREATE_TOOLS.has(name)) touch(act.created, p);
	}
	return act;
};

/** Cumulative merge: previous activity first, fresh activity re-touched on top. */
export const mergeFileActivity = (
	prev: FileActivity | undefined,
	fresh: FileActivity,
	limit = FILE_ACTIVITY_STORE_LIMIT,
): FileActivity => {
	const out = emptyFileActivity();
	for (const key of CATEGORIES) {
		const list: string[] = [];
		for (const p of prev?.[key] ?? []) touch(list, p);
		for (const p of fresh[key]) touch(list, p);
		out[key] = newest(list, limit);
	}
	return out;
};

/**
 * Find the longest common directory prefix among absolute paths.
 * Returns "" if fewer than 2 absolute paths or no meaningful common prefix.
 */
const longestCommonDirPrefix = (paths: string[]): string => {
	const abs = paths.filter((p) => p.startsWith("/"));
	if (abs.length < 2) return "";
	const split = abs.map((p) => p.split("/"));
	const min = Math.min(...split.map((s) => s.length));
	let i = 0;
	while (i < min - 1) {
		const seg = split[0][i];
		if (!split.every((s) => s[i] === seg)) break;
		i++;
	}
	if (i < 2) return ""; // require at least /a/b common
	return `${split[0].slice(0, i).join("/")}/`;
};

export interface PathDisplayOptions {
	/** Session cwd: paths below it render relative (Pi tools resolve them against cwd). */
	root?: string;
	/** Home directory: other paths below it render as `~/...` (Pi tools expand `~`). */
	home?: string;
}

const withSlash = (dir: string): string => (dir.endsWith("/") ? dir : `${dir}/`);

// A root must name a real directory below `/`, or every path would render relative.
const usableDir = (dir: string | undefined): string | undefined =>
	dir?.startsWith("/") && dir.split("/").some(Boolean) ? withSlash(dir) : undefined;

const makeDisplayPath = (paths: string[], options?: PathDisplayOptions): ((p: string) => string) => {
	const root = usableDir(options?.root);
	const home = usableDir(options?.home);
	if (root || home) {
		return (p) => {
			if (root && p.startsWith(root)) return p.slice(root.length);
			if (home && p.startsWith(home)) return `~/${p.slice(home.length)}`;
			return p;
		};
	}
	// No cwd known (tests, offline tools): trim the common prefix of what is shown.
	const prefix = longestCommonDirPrefix(paths);
	return (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
};

/**
 * Summary lines for [Files And Changes]: the most recently touched paths per
 * list, with the count of older ones. A file that was modified is listed only
 * under Modified (not again under Created or Read).
 */
export const renderFileActivity = (act: FileActivity, options?: PathDisplayOptions & { limit?: number }): string[] => {
	const limit = options?.limit ?? FILE_ACTIVITY_DISPLAY_LIMIT;
	const isModified = (p: string) => act.modified.some((m) => sameFile(m, p));
	const groups: Array<[label: string, list: string[]]> = [
		["Modified", act.modified],
		["Created", act.created.filter((p) => !isModified(p))],
		["Read", act.read.filter((p) => !isModified(p))],
	];
	const displayPath = makeDisplayPath(
		groups.flatMap(([, list]) => newest(list, limit)),
		options,
	);
	const lines: string[] = [];
	for (const [label, list] of groups) {
		if (list.length === 0) continue;
		const visible = newest(list, limit).map(displayPath);
		const hidden = list.length - visible.length;
		lines.push(`${label}: ${visible.join(", ")}${hidden > 0 ? ` (+${hidden} earlier)` : ""}`);
	}
	return lines;
};

const LINE_RE = /^- (Modified|Created|Read): (.*)$/;
const LABEL_KEY = { Modified: "modified", Created: "created", Read: "read" } as const;

/**
 * Parse a rendered [Files And Changes] section from a summary written without
 * structured state (earlier versions). Wrap-aware: continuation lines are
 * re-joined first. Returns undefined when the section has no file lines.
 */
export const parseFileActivitySection = (section: string): FileActivity | undefined => {
	if (!section) return undefined;
	const act = emptyFileActivity();
	let found = false;
	for (const line of unwrapHeaderLines(section)) {
		const m = LINE_RE.exec(line);
		if (!m) continue;
		found = true;
		const rest = m[2].replace(/\s*\(\+\d+ (?:more|earlier)\)\s*$/, "");
		for (const part of rest.split(/,\s+/)) {
			const trimmed = part.trim().replace(/,$/, "");
			const p = trimmed.startsWith("~/") ? `${withSlash(homedir())}${trimmed.slice(2)}` : trimmed;
			if (p) touch(act[LABEL_KEY[m[1] as keyof typeof LABEL_KEY]], p);
		}
	}
	return found ? act : undefined;
};

/** Validate persisted state read back from a session file (never trust its shape). */
export const readFileActivity = (raw: unknown): FileActivity | undefined => {
	if (!raw || typeof raw !== "object") return undefined;
	const out = emptyFileActivity();
	for (const key of CATEGORIES) {
		const list = (raw as Record<string, unknown>)[key];
		if (list === undefined) continue;
		if (!Array.isArray(list)) return undefined;
		out[key] = list.filter((p): p is string => typeof p === "string" && p.length > 0);
	}
	return out;
};
