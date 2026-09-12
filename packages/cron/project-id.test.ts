import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeRemoteUrl, resolveProjectId } from "./project-id.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cron project identity", () => {
	it("uses the same root commit identity for a temporary Git worktree", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cron-project-"));
		directories.push(root);
		const worktree = join(root, "worktree");
		// A commit hook's index path belongs to its repository, not this fixture or its worktree.
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: root,
				env: { ...process.env, GIT_INDEX_FILE: undefined },
				stdio: "pipe",
			});
		git("init");
		git("config", "user.email", "cron@example.test");
		git("config", "user.name", "Cron Test");
		writeFileSync(join(root, "README.md"), "test\n");
		git("add", "README.md");
		git("commit", "-m", "initial");
		git("worktree", "add", "-b", "cron-worktree", worktree);

		expect(resolveProjectId(worktree)).toEqual(resolveProjectId(root));
	});

	it("normalizes SSH and HTTPS remote identities consistently", () => {
		expect(normalizeRemoteUrl("git@github.com:acme/app.git")).toBe("github-com-acme-app");
		expect(normalizeRemoteUrl("https://github.com/acme/app.git")).toBe("github-com-acme-app");
	});
});
