import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./git.ts";

describe("diff-review git helpers", () => {
	it("parses porcelain status and keeps only reviewable untracked paths", () => {
		const output = [
			"?? src/new-file.ts",
			" M src/existing.ts",
			"R  src/renamed.ts",
			"src/original.ts",
			"?? dist/app.min.js",
		].join("\0");
		const info = __testing.parseStatusPorcelainZ(`${output}\0`);

		expect(info).toMatchObject({
			hasChanges: true,
			hasReviewableChanges: true,
			hasUntracked: true,
			hasTrackedDeletions: false,
			hasRenames: true,
			untrackedPaths: ["src/new-file.ts"],
		});
	});

	it("only falls back to snapshot normalization when reviewable rename candidates exist", () => {
		expect(
			__testing.shouldNormalizeBranchChanges([{ status: "deleted", oldPath: "src/old.ts", newPath: null }], {
				hasChanges: true,
				hasReviewableChanges: true,
				hasUntracked: true,
				hasTrackedDeletions: true,
				hasRenames: false,
				untrackedPaths: ["src/new.ts"],
			}),
		).toBe(true);

		expect(
			__testing.shouldNormalizeBranchChanges([{ status: "modified", oldPath: "src/file.ts", newPath: "src/file.ts" }], {
				hasChanges: true,
				hasReviewableChanges: true,
				hasUntracked: true,
				hasTrackedDeletions: false,
				hasRenames: false,
				untrackedPaths: ["src/new.ts"],
			}),
		).toBe(false);

		expect(
			__testing.shouldNormalizeBranchChanges([{ status: "modified", oldPath: "src/file.ts", newPath: "src/file.ts" }], {
				hasChanges: true,
				hasReviewableChanges: true,
				hasUntracked: false,
				hasTrackedDeletions: false,
				hasRenames: true,
				untrackedPaths: [],
			}),
		).toBe(true);
	});
	describe("review base selection", () => {
		const originalEnv = process.env.DIFF_REVIEW_BASE;

		afterEach(() => {
			if (originalEnv === undefined) delete process.env.DIFF_REVIEW_BASE;
			else process.env.DIFF_REVIEW_BASE = originalEnv;
		});

		function fakePi(mergeBases: Record<string, string>, refList = ""): { pi: ExtensionAPI; calls: string[][] } {
			const calls: string[][] = [];
			const pi = {
				exec: async (_command: string, args: string[]) => {
					calls.push(args);
					if (args[0] === "merge-base") {
						const sha = mergeBases[args[2] ?? ""];
						return sha ? { code: 0, stdout: `${sha}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
					}
					if (args[0] === "for-each-ref") return { code: 0, stdout: refList, stderr: "" };
					return { code: 1, stdout: "", stderr: "" };
				},
			} as unknown as ExtensionAPI;
			return { pi, calls };
		}

		it("uses an explicit base ref ahead of auto-detection", async () => {
			delete process.env.DIFF_REVIEW_BASE;
			const { pi } = fakePi({ "origin/main": "aaa", "release/1.0": "bbb" });
			await expect(__testing.findReviewBase(pi, "/repo", "release/1.0")).resolves.toEqual({
				mergeBase: "bbb",
				baseRef: "release/1.0",
			});
		});

		it("throws when an explicit base ref has no merge base or looks like an option", async () => {
			const { pi } = fakePi({ "origin/main": "aaa" });
			await expect(__testing.findReviewBase(pi, "/repo", "nope")).rejects.toThrow(/merge base/);
			await expect(__testing.findReviewBase(pi, "/repo", "--output=x")).rejects.toThrow(/Invalid base ref/);
		});

		it("prefers DIFF_REVIEW_BASE over auto-detection and falls back when it does not resolve", async () => {
			const { pi } = fakePi({ "origin/main": "aaa", develop2: "ccc" });
			process.env.DIFF_REVIEW_BASE = "develop2";
			await expect(__testing.findReviewBase(pi, "/repo")).resolves.toEqual({ mergeBase: "ccc", baseRef: "develop2" });
			process.env.DIFF_REVIEW_BASE = "missing";
			await expect(__testing.findReviewBase(pi, "/repo")).resolves.toEqual({
				mergeBase: "aaa",
				baseRef: "origin/main",
			});
		});

		it("lists local and remote branches without HEAD pointers or option-like refs", async () => {
			const { pi } = fakePi({}, ["main", "origin", "origin/HEAD", "origin/main", "feature/x", "main", ""].join("\n"));
			await expect(__testing.listBaseRefCandidates(pi, "/repo")).resolves.toEqual(["main", "origin/main", "feature/x"]);
		});
	});
});
