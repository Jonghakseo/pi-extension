import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getPresetCompletions, loadPresets, parsePreset } from "./presets.ts";

const tempDirs: string[] = [];

async function createPresetDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "until-presets-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("until presets", () => {
	it("parses BOM and CRLF frontmatter", () => {
		expect(
			parsePreset("\uFEFF---\r\ninterval: 15m\r\ndescription: Review queue\r\n---\r\nCheck reviews.", "review"),
		).toEqual({
			defaultInterval: { ms: 15 * 60_000, label: "15분" },
			description: "Review queue",
			name: "REVIEW",
			prompt: "Check reviews.",
		});
	});

	it("uses defaults and rejects empty or malformed presets", () => {
		expect(parsePreset("Check the PR.", "pr")).toMatchObject({
			defaultInterval: { ms: 5 * 60_000, label: "5분" },
			description: "PR",
			name: "PR",
			prompt: "Check the PR.",
		});
		expect(() => parsePreset("---\ninterval: 5m\n---\n", "empty")).toThrow("본문이 비어");
		expect(() => parsePreset("---\ninterval: soon\n---\nCheck.", "bad")).toThrow("interval");
		expect(() => parsePreset("---\ninterval: 5m\nCheck.", "open")).toThrow("frontmatter");
	});

	it("loads and completes only valid markdown presets", async () => {
		const dir = await createPresetDir();
		await writeFile(join(dir, "review.md"), "---\ninterval: 15m\ndescription: Review status\n---\nCheck reviews.");
		await writeFile(join(dir, "invalid.md"), "---\ninterval: soon\n---\nNope.");
		await writeFile(join(dir, "empty.md"), "---\ninterval: 5m\n---\n");
		await writeFile(join(dir, "notes.txt"), "ignored");

		await expect(loadPresets(dir)).resolves.toEqual({
			REVIEW: {
				defaultInterval: { ms: 15 * 60_000, label: "15분" },
				description: "Review status",
				name: "REVIEW",
				prompt: "Check reviews.",
			},
		});
		expect(getPresetCompletions(dir, "re")).toEqual([{ label: "REVIEW - Review status (15분)", value: "REVIEW" }]);
		expect(getPresetCompletions(dir, "in")).toBeNull();
	});

	it("returns no presets when the directory does not exist", async () => {
		const dir = join(tmpdir(), `until-missing-${Date.now()}`);
		await expect(loadPresets(dir)).resolves.toEqual({});
		expect(getPresetCompletions(dir, "")).toBeNull();
	});
});
