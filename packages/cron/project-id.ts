import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

export interface ProjectIdResult {
	id: string;
	basis: "remote" | "commit" | "path";
}

export function normalizeRemoteUrl(url: string): string {
	let normalized = url.trim();
	const sshMatch = normalized.match(/^[\w-]+@([\w.-]+):(.*)/);
	if (sshMatch) normalized = `${sshMatch[1]}/${sshMatch[2]}`;
	return normalized
		.replace(/^https?:\/\//, "")
		.replace(/^ssh:\/\//, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "")
		.replace(/^[\w-]+@/, "")
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

function git(command: string, cwd: string): string | undefined {
	try {
		return execSync(command, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

export function resolveProjectId(cwd: string): ProjectIdResult {
	const remote = git("git remote get-url origin", cwd);
	if (remote) return { id: normalizeRemoteUrl(remote), basis: "remote" };
	const rootCommit = git("git rev-list --max-parents=0 HEAD", cwd)?.split("\n")[0]?.trim();
	if (rootCommit) return { id: `commit-${rootCommit.slice(0, 8)}`, basis: "commit" };
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
	return { id: `local-${hash}`, basis: "path" };
}
