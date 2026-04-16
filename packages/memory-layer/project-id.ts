import { execSync } from "node:child_process";
import crypto from "node:crypto";
import type { ProjectIdResult } from "./types.ts";

/**
 * Normalize a git remote URL to a slug.
 *   https://github.com/acme-org/my-app.git → github-acme-org-my-app
 *   git@github.com:acme-org/my-app.git     → github-acme-org-my-app
 */
export function normalizeRemoteUrl(url: string): string {
	let normalized = url.trim();

	// SSH: git@github.com:org/repo.git → github.com/org/repo.git
	const sshMatch = normalized.match(/^[\w-]+@([\w.-]+):(.*)/);
	if (sshMatch) {
		normalized = `${sshMatch[1]}/${sshMatch[2]}`;
	}

	// Strip protocol
	normalized = normalized.replace(/^https?:\/\//, "");
	normalized = normalized.replace(/^ssh:\/\//, "");

	// Strip trailing .git
	normalized = normalized.replace(/\.git$/, "");

	// Strip trailing slashes
	normalized = normalized.replace(/\/+$/, "");

	// Strip user@ prefix (e.g. git@)
	normalized = normalized.replace(/^[\w-]+@/, "");

	// Replace non-alphanumeric with hyphens, collapse, trim
	return normalized
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

function shortHash(input: string): string {
	return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function execGit(command: string, cwd: string): string | null {
	try {
		return execSync(command, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return null;
	}
}

/**
 * Resolve project ID from cwd, with git worktree support.
 *
 * Priority:
 *   1. git remote origin URL → slug
 *   2. Root commit hash → commit-{hash8}
 *   3. cwd path → local-{hash8}
 */
export function resolveProjectId(cwd: string): ProjectIdResult {
	// 1. Try git remote origin
	const remoteUrl = execGit("git remote get-url origin", cwd);
	if (remoteUrl) {
		return { id: normalizeRemoteUrl(remoteUrl), basis: "remote" };
	}

	// 2. Try root commit hash (git repo without remote)
	const rootCommit = execGit("git rev-list --max-parents=0 HEAD", cwd);
	if (rootCommit) {
		const firstLine = rootCommit.split("\n")[0]?.trim();
		if (firstLine) {
			return { id: `commit-${firstLine.slice(0, 8)}`, basis: "commit" };
		}
	}

	// 3. Fallback: cwd path hash
	return { id: `local-${shortHash(cwd)}`, basis: "path" };
}
