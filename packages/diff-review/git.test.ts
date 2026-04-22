import { describe, expect, it } from "vitest";
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
});
