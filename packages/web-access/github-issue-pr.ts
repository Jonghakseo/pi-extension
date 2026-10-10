import { execFile } from "node:child_process";
import { activityMonitor } from "./activity.js";
import { loadConfigSection, normalizeBoolean } from "./config.js";
import type { ExtractedContent } from "./extract.js";

const GH_CALL_TIMEOUT_MS = 15_000;
const GH_TOTAL_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 10 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const MAX_DOC_CHARS = 150_000;
const MAX_FILES_SHOWN = 100;

type Kind = "pull" | "issue";
type JsonRecord = Record<string, unknown>;

export interface GitHubIssuePrUrlInfo {
	owner: string;
	repo: string;
	kind: Kind;
	number: number;
	/** `issuecomment-<id>` or `discussion_r<id>` */
	anchor?: string;
}

interface GitHubPrIssueConfig {
	enabled: boolean;
}

const DEFAULTS: GitHubPrIssueConfig = { enabled: true };

function loadGitHubPrIssueConfig(): GitHubPrIssueConfig {
	return loadConfigSection("github-pr-issue", DEFAULTS, (raw) => {
		const section = raw.githubPrIssue ?? {};
		return { enabled: normalizeBoolean(section.enabled, DEFAULTS.enabled) };
	});
}

function validOwner(owner: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) && !owner.includes("--");
}

function validRepo(repo: string): boolean {
	return /^[A-Za-z0-9._-]{1,100}$/.test(repo) && repo !== "." && repo !== "..";
}

/**
 * Recognise `github.com/<owner>/<repo>/pull/<n>` and `/issues/<n>`, optionally with a
 * `#issuecomment-<id>` or `#discussion_r<id>` fragment. Anything else (repo roots, blobs,
 * `/pull/<n>/files`, ...) is left to the other extractors.
 */
export function parseGitHubIssuePrUrl(url: string): GitHubIssuePrUrlInfo | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const host = parsed.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

	const segments: string[] = [];
	for (const segment of parsed.pathname.split("/").filter(Boolean)) {
		try {
			segments.push(decodeURIComponent(segment));
		} catch {
			return null;
		}
	}
	if (segments.length !== 4) return null;

	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, "");
	if (!validOwner(owner) || !validRepo(repo)) return null;

	const route = segments[2].toLowerCase();
	if (route !== "pull" && route !== "issues") return null;
	if (!/^\d+$/.test(segments[3])) return null;
	const number = Number.parseInt(segments[3], 10);
	if (!Number.isSafeInteger(number) || number <= 0) return null;

	const fragment = parsed.hash.slice(1);
	const anchorPattern = route === "pull" ? /^(?:issuecomment-\d+|discussion_r\d+)$/i : /^issuecomment-\d+$/i;
	const anchor = anchorPattern.test(fragment) ? fragment.toLowerCase() : undefined;
	return { owner, repo, kind: route === "pull" ? "pull" : "issue", number, ...(anchor ? { anchor } : {}) };
}

// ─── gh api ─────────────────────────────────────────────────────────────────

class GhCalls {
	private readonly deadline = Date.now() + GH_TOTAL_TIMEOUT_MS;

	constructor(private readonly signal?: AbortSignal) {}

	/** Run `gh api <path>` and parse the JSON body. Returns null on any failure. */
	async api(path: string): Promise<unknown | null> {
		const remaining = this.deadline - Date.now();
		if (remaining <= 0 || this.signal?.aborted) return null;
		return new Promise((resolve) => {
			execFile(
				"gh",
				["api", path],
				{
					timeout: Math.min(GH_CALL_TIMEOUT_MS, remaining),
					maxBuffer: GH_MAX_BUFFER,
					...(this.signal ? { signal: this.signal } : {}),
					env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
				},
				(err, stdout) => {
					if (err) {
						resolve(null);
						return;
					}
					try {
						resolve(JSON.parse(stdout));
					} catch {
						resolve(null);
					}
				},
			);
		});
	}

	/** Fetch up to MAX_PAGES pages of a list endpoint. `complete` is false if truncated or a page failed. */
	async list(path: string): Promise<{ items: JsonRecord[]; complete: boolean; failed: boolean }> {
		const items: JsonRecord[] = [];
		const separator = path.includes("?") ? "&" : "?";
		for (let page = 1; page <= MAX_PAGES; page++) {
			const body = await this.api(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
			if (!Array.isArray(body)) return { items, complete: false, failed: items.length === 0 };
			const records = body.filter(isRecord);
			items.push(...records);
			if (body.length < PAGE_SIZE) return { items, complete: true, failed: false };
		}
		return { items, complete: false, failed: false };
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function login(value: unknown): string {
	return (isRecord(value) && str(value.login)) || "unknown";
}

function names(value: unknown, key: "name" | "login"): string {
	if (!Array.isArray(value)) return "none";
	const list = value.map((item) => (isRecord(item) ? str(item[key]) : "")).filter(Boolean);
	return list.length > 0 ? list.join(", ") : "none";
}

function commentId(comment: JsonRecord): string {
	return String(comment.id ?? "");
}

// An anchored comment must belong to the PR/issue in the URL, not just share an id.
function belongsTo(comment: JsonRecord, field: "issue_url" | "pull_request_url", info: GitHubIssuePrUrlInfo): boolean {
	const value = str(comment[field]);
	if (!value) return false;
	try {
		const parsed = new URL(value);
		const route = field === "issue_url" ? "issues" : "pulls";
		return (
			parsed.hostname.toLowerCase() === "api.github.com" &&
			parsed.pathname.toLowerCase() === `/repos/${info.owner}/${info.repo}/${route}/${info.number}`.toLowerCase()
		);
	} catch {
		return false;
	}
}

// ─── rendering ──────────────────────────────────────────────────────────────

interface RenderData {
	url: string;
	info: GitHubIssuePrUrlInfo;
	main: JsonRecord;
	comments: JsonRecord[];
	commentsNote?: string;
	reviews: JsonRecord[];
	reviewComments: JsonRecord[];
	reviewCommentsNote?: string;
	files: JsonRecord[];
	filesNote?: string;
	anchorMissing: boolean;
}

function indent(text: string): string {
	return text.replace(/\n/g, "\n  ");
}

function renderComment(
	comment: JsonRecord,
	anchor: string | undefined,
	prefix: "issuecomment-" | "discussion_r",
): string {
	const id = commentId(comment);
	const anchored = anchor === `${prefix}${id}` ? " [anchored]" : "";
	const body = str(comment.body).trim() || "(empty)";
	const where = str(comment.path)
		? ` on ${str(comment.path)}:${num(comment.line) ?? num(comment.original_line) ?? "?"}`
		: "";
	return `- ${login(comment.user)} at ${str(comment.created_at) || "unknown"}${where}${anchored}:\n  ${indent(body)}`;
}

export function renderGitHubPrIssue(data: RenderData): ExtractedContent {
	const { info, main } = data;
	const isPull = info.kind === "pull";
	const title = str(main.title) || `${info.owner}/${info.repo}#${info.number}`;
	const lines: string[] = [`# #${info.number} ${title}`, ""];

	const state = [str(main.state) || "unknown"];
	if (isPull) {
		if (str(main.merged_at)) state[0] = "merged";
		if (main.draft === true) state.push("draft");
	}
	const reason = str(main.state_reason);
	lines.push(`- repository: ${info.owner}/${info.repo}`);
	lines.push(`- type: ${isPull ? "pull request" : "issue"}`);
	lines.push(`- state: ${state.join(" ")}${reason ? ` (${reason})` : ""}`);
	lines.push(`- author: ${login(main.user)}`);
	if (isPull) {
		const base = isRecord(main.base) ? str(main.base.ref) : "";
		const head = isRecord(main.head) ? str(main.head.ref) : "";
		lines.push(`- branch: ${base} <- ${head}`);
		lines.push(
			`- changes: +${num(main.additions) ?? 0} -${num(main.deletions) ?? 0}, ${num(main.changed_files) ?? data.files.length} files, ${num(main.commits) ?? "?"} commits`,
		);
	} else {
		lines.push(`- assignees: ${names(main.assignees, "login")}`);
	}
	lines.push(`- created: ${str(main.created_at) || "unknown"}`);
	if (str(main.merged_at)) lines.push(`- merged: ${str(main.merged_at)}`);
	if (str(main.closed_at)) lines.push(`- closed: ${str(main.closed_at)}`);
	lines.push(`- labels: ${names(main.labels, "name")}`);
	lines.push(`- milestone: ${isRecord(main.milestone) ? str(main.milestone.title) || "none" : "none"}`);
	if (info.anchor) lines.push(`- requested anchor: #${info.anchor}`);
	lines.push("", "## Description", str(main.body).trim() || "(empty)", "");

	if (isPull) {
		const verdicts = data.reviews.filter((review) => str(review.state) !== "PENDING");
		lines.push("## Reviews");
		if (verdicts.length === 0) {
			lines.push("none");
		} else {
			for (const review of verdicts) {
				const body = str(review.body).trim();
				lines.push(`- ${login(review.user)}: ${str(review.state) || "COMMENTED"}${body ? `\n  ${indent(body)}` : ""}`);
			}
		}
		lines.push("");

		lines.push("## Files");
		if (data.files.length === 0) {
			lines.push(data.filesNote ?? "none");
		} else {
			for (const file of data.files.slice(0, MAX_FILES_SHOWN)) {
				lines.push(`- ${str(file.filename) || "file"} (+${num(file.additions) ?? 0}/-${num(file.deletions) ?? 0})`);
			}
			const total = num(main.changed_files);
			if (total !== null && total > Math.min(data.files.length, MAX_FILES_SHOWN)) {
				lines.push(`[${Math.min(data.files.length, MAX_FILES_SHOWN)} of ${total} files shown]`);
			}
		}
		lines.push("");
	}

	lines.push("## Conversation comments");
	if (data.comments.length === 0) {
		lines.push(data.commentsNote ?? "none");
	} else {
		for (const comment of data.comments) lines.push(renderComment(comment, info.anchor, "issuecomment-"));
		if (data.commentsNote) lines.push(data.commentsNote);
	}
	if (data.anchorMissing && info.anchor?.startsWith("issuecomment-")) {
		lines.push("[anchored comment unavailable for this pull request or issue]");
	}
	lines.push("");

	if (isPull) {
		lines.push("## Review comments");
		if (data.reviewComments.length === 0) {
			lines.push(data.reviewCommentsNote ?? "none");
		} else {
			for (const comment of data.reviewComments) lines.push(renderComment(comment, info.anchor, "discussion_r"));
			if (data.reviewCommentsNote) lines.push(data.reviewCommentsNote);
		}
		if (data.anchorMissing && info.anchor?.startsWith("discussion_r")) {
			lines.push("[anchored review comment unavailable for this pull request]");
		}
		lines.push("");
	}

	lines.push("## Full view");
	lines.push(
		isPull
			? `- \`gh pr view ${info.number} --repo ${info.owner}/${info.repo} --comments\``
			: `- \`gh issue view ${info.number} --repo ${info.owner}/${info.repo} --comments\``,
	);
	if (isPull) lines.push(`- \`gh pr diff ${info.number} --repo ${info.owner}/${info.repo}\``);

	const content = lines.join("\n");
	return {
		url: data.url,
		title: `${info.owner}/${info.repo} ${isPull ? "pull request" : "issue"} #${info.number}: ${title}`,
		content:
			content.length > MAX_DOC_CHARS
				? `${content.slice(0, MAX_DOC_CHARS)}\n\n[GitHub document truncated at ${MAX_DOC_CHARS} chars; use the gh commands for complete data]`
				: content,
		error: null,
	};
}

// ─── extraction ─────────────────────────────────────────────────────────────

function truncationNote(label: string, shown: number, complete: boolean, failed: boolean): string | undefined {
	if (failed) return `[${label} unavailable from gh]`;
	if (!complete) return `[${shown} ${label} shown; more exist, use gh for the rest]`;
	return undefined;
}

/**
 * Render a PR or issue through `gh api`. Returns null when the URL is not a PR/issue, the
 * feature is disabled, or gh is missing/unauthenticated/failing, so the caller can fall
 * back to the normal HTTP path.
 */
export async function extractGitHubIssuePr(url: string, signal?: AbortSignal): Promise<ExtractedContent | null> {
	const info = parseGitHubIssuePrUrl(url);
	if (!info) return null;
	if (!loadGitHubPrIssueConfig().enabled) return null;
	if (signal?.aborted) return null;

	const gh = new GhCalls(signal);
	const base = `repos/${info.owner}/${info.repo}`;
	const isPull = info.kind === "pull";
	const activityId = activityMonitor.logStart({
		type: "fetch",
		url: `github.com/${info.owner}/${info.repo}#${info.number}`,
	});

	const main = await gh.api(isPull ? `${base}/pulls/${info.number}` : `${base}/issues/${info.number}`);
	if (!isRecord(main)) {
		activityMonitor.logError(activityId, "gh api failed");
		return null;
	}

	const [comments, reviews, reviewComments, files] = await Promise.all([
		gh.list(`${base}/issues/${info.number}/comments`),
		isPull ? gh.list(`${base}/pulls/${info.number}/reviews`) : undefined,
		isPull ? gh.list(`${base}/pulls/${info.number}/comments`) : undefined,
		isPull ? gh.list(`${base}/pulls/${info.number}/files`) : undefined,
	]);
	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	let anchorMissing = false;
	const anchorMatch = info.anchor?.match(/^(issuecomment-|discussion_r)(\d+)$/);
	if (anchorMatch) {
		const [, prefix, id] = anchorMatch;
		const isIssueComment = prefix === "issuecomment-";
		const target = isIssueComment ? comments.items : (reviewComments?.items ?? []);
		if (!target.some((comment) => commentId(comment) === id)) {
			const fetched = await gh.api(isIssueComment ? `${base}/issues/comments/${id}` : `${base}/pulls/comments/${id}`);
			if (isRecord(fetched) && belongsTo(fetched, isIssueComment ? "issue_url" : "pull_request_url", info)) {
				target.push(fetched);
			} else {
				anchorMissing = true;
			}
		}
	}

	const result = renderGitHubPrIssue({
		url,
		info,
		main,
		comments: comments.items,
		commentsNote: truncationNote("comments", comments.items.length, comments.complete, comments.failed),
		reviews: reviews?.items ?? [],
		reviewComments: reviewComments?.items ?? [],
		reviewCommentsNote: reviewComments
			? truncationNote("review comments", reviewComments.items.length, reviewComments.complete, reviewComments.failed)
			: undefined,
		files: files?.items ?? [],
		filesNote: files ? truncationNote("files", files.items.length, files.complete, files.failed) : undefined,
		anchorMissing,
	});
	activityMonitor.logComplete(activityId, 200);
	return result;
}
