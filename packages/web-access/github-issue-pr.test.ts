import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfigPathForTests } from "./config.js";
import { extractContent } from "./extract.js";
import { extractGitHubIssuePr, parseGitHubIssuePrUrl } from "./github-issue-pr.js";

describe("parseGitHubIssuePrUrl", () => {
	it("recognises pull and issue URLs with comment anchors", () => {
		expect(parseGitHubIssuePrUrl("https://github.com/acme/widgets/pull/12")).toEqual({
			owner: "acme",
			repo: "widgets",
			kind: "pull",
			number: 12,
		});
		expect(parseGitHubIssuePrUrl("https://github.com/acme/widgets/issues/7#issuecomment-99")).toMatchObject({
			kind: "issue",
			number: 7,
			anchor: "issuecomment-99",
		});
		expect(parseGitHubIssuePrUrl("https://github.com/acme/widgets/pull/12#discussion_r345")).toMatchObject({
			anchor: "discussion_r345",
		});
	});

	it("leaves repo, file and other URLs to the other extractors", () => {
		for (const url of [
			"https://github.com/acme/widgets",
			"https://github.com/acme/widgets/blob/main/README.md",
			"https://github.com/acme/widgets/pull/12/files",
			"https://github.com/acme/widgets/pulls",
			"https://github.com/acme/widgets/issues/abc",
			"https://example.com/acme/widgets/pull/12",
		]) {
			expect(parseGitHubIssuePrUrl(url)).toBeNull();
		}
		// issues do not have review-thread anchors
		expect(parseGitHubIssuePrUrl("https://github.com/acme/widgets/issues/7#discussion_r1")?.anchor).toBeUndefined();
	});
});

describe("PR and issue extraction through gh api", () => {
	let dir: string;
	let originalPath: string | undefined;
	let callLog: string;

	const pull = {
		title: "Add retry to uploader",
		state: "closed",
		merged_at: "2025-03-02T00:00:00Z",
		closed_at: "2025-03-02T00:00:00Z",
		created_at: "2025-03-01T00:00:00Z",
		user: { login: "alice" },
		base: { ref: "main" },
		head: { ref: "retry" },
		additions: 10,
		deletions: 2,
		changed_files: 1,
		commits: 3,
		labels: [{ name: "bug" }],
		body: "Retries failed uploads three times.",
	};
	const issue = {
		title: "Uploader drops files",
		state: "open",
		created_at: "2025-02-01T00:00:00Z",
		user: { login: "carol" },
		assignees: [{ login: "dave" }],
		labels: [],
		body: "Files vanish after a timeout.",
	};
	const issueComment = (id: number, body: string, issueNumber = 12) => ({
		id,
		body,
		user: { login: "bob" },
		created_at: "2025-03-01T01:00:00Z",
		issue_url: `https://api.github.com/repos/acme/widgets/issues/${issueNumber}`,
	});
	const reviewComment = (id: number, body: string, pullNumber = 12) => ({
		id,
		body,
		path: "src/upload.ts",
		line: 42,
		user: { login: "erin" },
		created_at: "2025-03-01T02:00:00Z",
		pull_request_url: `https://api.github.com/repos/acme/widgets/pulls/${pullNumber}`,
	});

	/** Install a fake `gh` that answers `gh api <path>` from a path -> JSON table. */
	function installGh(responses: Record<string, unknown>): void {
		const table = join(dir, "responses.json");
		writeFileSync(table, JSON.stringify(responses));
		callLog = join(dir, "calls.log");
		const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = process.argv[3] || "";
fs.appendFileSync(${JSON.stringify(callLog)}, process.argv.slice(2).join(" ") + "\\n");
const table = JSON.parse(fs.readFileSync(${JSON.stringify(table)}, "utf8"));
const key = path.replace(/[?&]per_page=\\d+&page=\\d+$/, "");
if (process.argv[2] !== "api" || !(key in table)) { process.stderr.write("gh: Not Found (HTTP 404)"); process.exit(1); }
process.stdout.write(JSON.stringify(table[key]));
`;
		const bin = join(dir, "bin");
		const gh = join(bin, "gh");
		mkdirSync(bin, { recursive: true });
		writeFileSync(gh, script);
		chmodSync(gh, 0o755);
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
	}

	function writeConfig(config: unknown): void {
		const configPath = join(dir, "web-search.json");
		writeFileSync(configPath, JSON.stringify(config));
		setConfigPathForTests(configPath);
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "web-access-gh-pr-"));
		originalPath = process.env.PATH;
		setConfigPathForTests(null);
	});
	afterEach(() => {
		process.env.PATH = originalPath;
		setConfigPathForTests(null);
		rmSync(dir, { recursive: true, force: true });
	});

	it("renders a pull request with reviews, files and both kinds of comments", async () => {
		installGh({
			"repos/acme/widgets/pulls/12": pull,
			"repos/acme/widgets/issues/12/comments": [issueComment(1, "Looks good overall")],
			"repos/acme/widgets/pulls/12/reviews": [
				{ user: { login: "frank" }, state: "APPROVED", body: "Ship it" },
				{ user: { login: "gina" }, state: "PENDING", body: "draft review" },
			],
			"repos/acme/widgets/pulls/12/comments": [reviewComment(2, "Cap the retries")],
			"repos/acme/widgets/pulls/12/files": [{ filename: "src/upload.ts", additions: 10, deletions: 2 }],
		});

		const result = await extractContent("https://github.com/acme/widgets/pull/12");

		expect(result.error).toBeNull();
		expect(result.title).toBe("acme/widgets pull request #12: Add retry to uploader");
		expect(result.content).toContain("- state: merged");
		expect(result.content).toContain("- branch: main <- retry");
		expect(result.content).toContain("Retries failed uploads three times.");
		expect(result.content).toContain("frank: APPROVED");
		expect(result.content).not.toContain("draft review");
		expect(result.content).toContain("- src/upload.ts (+10/-2)");
		expect(result.content).toContain("bob at");
		expect(result.content).toContain("Looks good overall");
		expect(result.content).toContain("on src/upload.ts:42");
		expect(result.content).toContain("Cap the retries");
	});

	it("renders an issue without PR-only sections", async () => {
		installGh({
			"repos/acme/widgets/issues/7": issue,
			"repos/acme/widgets/issues/7/comments": [issueComment(5, "Reproduced on 2.1", 7)],
		});

		const result = await extractContent("https://github.com/acme/widgets/issues/7");

		expect(result.error).toBeNull();
		expect(result.content).toContain("- type: issue");
		expect(result.content).toContain("- assignees: dave");
		expect(result.content).toContain("Reproduced on 2.1");
		expect(result.content).not.toContain("## Review comments");
		expect(readFileSync(callLog, "utf8")).not.toContain("/pulls/");
	});

	it("fetches and marks a comment anchor that is not on the first pages", async () => {
		installGh({
			"repos/acme/widgets/issues/7": issue,
			"repos/acme/widgets/issues/7/comments": [issueComment(5, "first", 7)],
			"repos/acme/widgets/issues/comments/900": issueComment(900, "the one you linked", 7),
		});

		const result = await extractGitHubIssuePr("https://github.com/acme/widgets/issues/7#issuecomment-900");

		expect(result?.content).toMatch(/the one you linked/);
		expect(result?.content).toContain("[anchored]");
	});

	it("does not trust an anchored comment that belongs to another issue", async () => {
		installGh({
			"repos/acme/widgets/issues/7": issue,
			"repos/acme/widgets/issues/7/comments": [],
			"repos/acme/widgets/issues/comments/900": issueComment(900, "from elsewhere", 8),
		});

		const result = await extractGitHubIssuePr("https://github.com/acme/widgets/issues/7#issuecomment-900");

		expect(result?.content).not.toContain("from elsewhere");
		expect(result?.content).toContain("anchored comment unavailable");
	});

	it("returns null when gh fails so the caller can use the HTTP path", async () => {
		installGh({});
		expect(await extractGitHubIssuePr("https://github.com/acme/widgets/pull/12")).toBeNull();
	});

	it("returns null when gh is not installed", async () => {
		process.env.PATH = dir;
		expect(await extractGitHubIssuePr("https://github.com/acme/widgets/pull/12")).toBeNull();
	});

	it("skips gh entirely when githubPrIssue.enabled is false", async () => {
		installGh({ "repos/acme/widgets/pulls/12": pull });
		writeConfig({ githubPrIssue: { enabled: false } });

		expect(await extractGitHubIssuePr("https://github.com/acme/widgets/pull/12")).toBeNull();
		expect(() => readFileSync(callLog, "utf8")).toThrow();
	});
});
