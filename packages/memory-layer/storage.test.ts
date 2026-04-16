import { describe, expect, it } from "vitest";
import { memoryEntryId, parseIndex, parseTopicFile, sanitizeTopic, scoreMemorySearchMatch } from "./storage.ts";

// ---------------------------------------------------------------------------
// sanitizeTopic — slug sanitization & path confinement
// ---------------------------------------------------------------------------

describe("sanitizeTopic", () => {
	it("should lowercase and slugify a simple topic", () => {
		expect(sanitizeTopic("CodingRules")).toBe("codingrules");
	});

	it("should replace spaces and special chars with hyphens", () => {
		expect(sanitizeTopic("my cool topic!")).toBe("my-cool-topic");
	});

	it("should collapse multiple hyphens", () => {
		expect(sanitizeTopic("a---b")).toBe("a-b");
	});

	it("should strip leading and trailing hyphens", () => {
		expect(sanitizeTopic("-hello-")).toBe("hello");
	});

	it("should strip path traversal sequences", () => {
		expect(sanitizeTopic("../../etc/passwd")).toBe("etcpasswd");
	});

	it("should strip path separators", () => {
		expect(sanitizeTopic("foo/bar\\baz")).toBe("foobarbaz");
	});

	it("should preserve Korean characters", () => {
		expect(sanitizeTopic("코딩규칙")).toBe("코딩규칙");
	});

	it("should handle mixed Korean and ASCII", () => {
		expect(sanitizeTopic("나의 Rules 정리")).toBe("나의-rules-정리");
	});

	it("should truncate to 50 characters", () => {
		const long = "a".repeat(60);
		expect(sanitizeTopic(long).length).toBe(50);
	});

	it("should throw on empty result", () => {
		expect(() => sanitizeTopic("...")).toThrow("Invalid topic name");
	});

	it("should throw on whitespace-only input", () => {
		expect(() => sanitizeTopic("   ")).toThrow("Invalid topic name");
	});

	it("should throw on only special chars", () => {
		expect(() => sanitizeTopic("!@#$%^&*()")).toThrow("Invalid topic name");
	});

	it("should throw when path traversal leaves nothing", () => {
		expect(() => sanitizeTopic("....//....\\\\")).toThrow("Invalid topic name");
	});
});

// ---------------------------------------------------------------------------
// parseIndex — MEMORY.md index parsing
// ---------------------------------------------------------------------------

describe("parseIndex", () => {
	it("should parse a single section with entries", () => {
		const content = ["# Memory Index", "", "## coding-rules.md", "- Use strict mode", "- No any types", ""].join("\n");

		const sections = parseIndex(content);
		expect(sections).toHaveLength(1);
		expect(sections[0].topic).toBe("coding-rules");
		expect(sections[0].entries).toEqual(["Use strict mode", "No any types"]);
	});

	it("should parse multiple sections", () => {
		const content = [
			"# Memory Index",
			"",
			"## coding-rules.md",
			"- Rule 1",
			"",
			"## preferences.md",
			"- Pref 1",
			"- Pref 2",
			"",
		].join("\n");

		const sections = parseIndex(content);
		expect(sections).toHaveLength(2);
		expect(sections[0].topic).toBe("coding-rules");
		expect(sections[0].entries).toEqual(["Rule 1"]);
		expect(sections[1].topic).toBe("preferences");
		expect(sections[1].entries).toEqual(["Pref 1", "Pref 2"]);
	});

	it("should return empty array for empty content", () => {
		expect(parseIndex("")).toEqual([]);
	});

	it("should return empty array for content without sections", () => {
		expect(parseIndex("# Memory Index\n\nSome random text")).toEqual([]);
	});

	it("should ignore bullets before the first section header", () => {
		const content = ["- orphan bullet", "## topic.md", "- real entry"].join("\n");
		const sections = parseIndex(content);
		expect(sections).toHaveLength(1);
		expect(sections[0].entries).toEqual(["real entry"]);
	});

	it("should handle sections with no entries", () => {
		const content = ["## empty-topic.md", "## another.md", "- entry"].join("\n");
		const sections = parseIndex(content);
		expect(sections).toHaveLength(2);
		expect(sections[0].topic).toBe("empty-topic");
		expect(sections[0].entries).toEqual([]);
		expect(sections[1].topic).toBe("another");
		expect(sections[1].entries).toEqual(["entry"]);
	});
});

// ---------------------------------------------------------------------------
// parseTopicFile — new marker format
// ---------------------------------------------------------------------------

describe("parseTopicFile", () => {
	describe("new marker format", () => {
		it("should parse entries with base64 markers", () => {
			const title1 = Buffer.from("First Entry", "utf8").toString("base64");
			const title2 = Buffer.from("Second Entry", "utf8").toString("base64");
			const raw = [
				"# My Topic",
				"",
				`<!-- @entry: ${title1} -->`,
				"Content of first entry",
				"",
				`<!-- @entry: ${title2} -->`,
				"Content of second entry",
				"",
			].join("\n");

			const result = parseTopicFile(raw);
			expect(result.heading).toBe("My Topic");
			expect(result.entries).toHaveLength(2);
			expect(result.entries[0].title).toBe("First Entry");
			expect(result.entries[0].content).toBe("Content of first entry");
			expect(result.entries[1].title).toBe("Second Entry");
			expect(result.entries[1].content).toBe("Content of second entry");
		});

		it("should handle multiline content", () => {
			const title = Buffer.from("Multi", "utf8").toString("base64");
			const raw = ["# Topic", "", `<!-- @entry: ${title} -->`, "Line 1", "Line 2", "Line 3", ""].join("\n");

			const result = parseTopicFile(raw);
			expect(result.entries[0].content).toBe("Line 1\nLine 2\nLine 3");
		});

		it("should handle entries with ## in content without confusion", () => {
			const title = Buffer.from("Safe Entry", "utf8").toString("base64");
			const raw = [
				"# Topic",
				"",
				`<!-- @entry: ${title} -->`,
				"## This is NOT a heading, it's content",
				"More content",
				"",
			].join("\n");

			const result = parseTopicFile(raw);
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].content).toContain("## This is NOT a heading");
		});

		it("should handle Korean titles", () => {
			const title = Buffer.from("코딩 규칙", "utf8").toString("base64");
			const raw = ["# 메모리", "", `<!-- @entry: ${title} -->`, "Korean content", ""].join("\n");

			const result = parseTopicFile(raw);
			expect(result.entries[0].title).toBe("코딩 규칙");
		});
	});

	describe("legacy ## format", () => {
		it("should parse legacy format with ## headings", () => {
			const raw = [
				"# My Topic",
				"",
				"## First Entry",
				"Content of first",
				"",
				"## Second Entry",
				"Content of second",
				"",
			].join("\n");

			const result = parseTopicFile(raw);
			expect(result.heading).toBe("My Topic");
			expect(result.entries).toHaveLength(2);
			expect(result.entries[0].title).toBe("First Entry");
			expect(result.entries[0].content).toBe("Content of first");
			expect(result.entries[1].title).toBe("Second Entry");
			expect(result.entries[1].content).toBe("Content of second");
		});

		it("should handle legacy format with leading blank lines", () => {
			const raw = ["", "", "# Heading", "", "## Entry", "Body", ""].join("\n");

			const result = parseTopicFile(raw);
			expect(result.heading).toBe("Heading");
			expect(result.entries).toHaveLength(1);
		});

		it("should handle legacy format without H1 heading", () => {
			const raw = ["## Entry Only", "Some content"].join("\n");

			const result = parseTopicFile(raw);
			expect(result.heading).toBe("");
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].title).toBe("Entry Only");
		});
	});

	describe("format auto-detection", () => {
		it("should detect new format when marker is present", () => {
			const title = Buffer.from("Test", "utf8").toString("base64");
			const raw = `# Topic\n\n<!-- @entry: ${title} -->\nContent`;
			const result = parseTopicFile(raw);
			expect(result.entries[0].title).toBe("Test");
		});

		it("should fall back to legacy format when no markers", () => {
			const raw = "# Topic\n\n## Legacy Entry\nContent";
			const result = parseTopicFile(raw);
			expect(result.entries[0].title).toBe("Legacy Entry");
		});
	});

	it("should return empty entries for content without entries", () => {
		const raw = "# Just a heading\n\nSome text without entries";
		const result = parseTopicFile(raw);
		expect(result.heading).toBe("Just a heading");
		expect(result.entries).toEqual([]);
	});

	it("should return empty entries for empty string", () => {
		const result = parseTopicFile("");
		expect(result.heading).toBe("");
		expect(result.entries).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// scoreMemorySearchMatch — search scoring
// ---------------------------------------------------------------------------

describe("scoreMemorySearchMatch", () => {
	const target = {
		topic: "coding-rules",
		title: "Use strict TypeScript",
		content: "Always enable strict mode in tsconfig.json for type safety",
	};

	it("should return 0 for empty query", () => {
		expect(scoreMemorySearchMatch("", target)).toBe(0);
		expect(scoreMemorySearchMatch("   ", target)).toBe(0);
	});

	it("should score higher for title match than content match", () => {
		const titleScore = scoreMemorySearchMatch("strict TypeScript", target);
		const contentScore = scoreMemorySearchMatch("tsconfig.json", target);
		expect(titleScore).toBeGreaterThan(contentScore);
	});

	it("should score higher for phrase match in title than content-only match", () => {
		const titlePhraseScore = scoreMemorySearchMatch("strict typescript", target);
		const contentOnlyScore = scoreMemorySearchMatch("tsconfig.json", target);
		expect(titlePhraseScore).toBeGreaterThan(contentOnlyScore);
	});

	it("should score topic matches", () => {
		const score = scoreMemorySearchMatch("coding-rules", target);
		expect(score).toBeGreaterThan(0);
	});

	it("should score content matches", () => {
		const score = scoreMemorySearchMatch("type safety", target);
		expect(score).toBeGreaterThan(0);
	});

	it("should return 0 for non-matching query", () => {
		expect(scoreMemorySearchMatch("python django", target)).toBe(0);
	});

	it("should be case-insensitive", () => {
		const lowerScore = scoreMemorySearchMatch("strict typescript", target);
		const upperScore = scoreMemorySearchMatch("STRICT TYPESCRIPT", target);
		expect(lowerScore).toBe(upperScore);
	});

	it("should handle single-character tokens by falling back", () => {
		const score = scoreMemorySearchMatch("a", target);
		expect(score).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// memoryEntryId — deterministic ID generation
// ---------------------------------------------------------------------------

describe("memoryEntryId", () => {
	it("should return a 12-character hex string", () => {
		const id = memoryEntryId("user", undefined, "coding-rules", "Title", "Content");
		expect(id).toMatch(/^[a-f0-9]{12}$/);
	});

	it("should be deterministic for same inputs", () => {
		const id1 = memoryEntryId("user", undefined, "topic", "title", "content");
		const id2 = memoryEntryId("user", undefined, "topic", "title", "content");
		expect(id1).toBe(id2);
	});

	it("should differ for different scopes", () => {
		const userId = memoryEntryId("user", undefined, "topic", "title", "content");
		const projectId = memoryEntryId("project", "my-project", "topic", "title", "content");
		expect(userId).not.toBe(projectId);
	});

	it("should differ for different topics", () => {
		const id1 = memoryEntryId("user", undefined, "topic-a", "title", "content");
		const id2 = memoryEntryId("user", undefined, "topic-b", "title", "content");
		expect(id1).not.toBe(id2);
	});

	it("should differ for different titles", () => {
		const id1 = memoryEntryId("user", undefined, "topic", "title-a", "content");
		const id2 = memoryEntryId("user", undefined, "topic", "title-b", "content");
		expect(id1).not.toBe(id2);
	});

	it("should differ for different content", () => {
		const id1 = memoryEntryId("user", undefined, "topic", "title", "content-a");
		const id2 = memoryEntryId("user", undefined, "topic", "title", "content-b");
		expect(id1).not.toBe(id2);
	});

	it("should include projectId in the key when provided", () => {
		const withProject = memoryEntryId("project", "proj-a", "topic", "title", "content");
		const withDiffProject = memoryEntryId("project", "proj-b", "topic", "title", "content");
		expect(withProject).not.toBe(withDiffProject);
	});

	it("should treat undefined projectId as empty string", () => {
		const id1 = memoryEntryId("user", undefined, "topic", "title", "content");
		const id2 = memoryEntryId("user", undefined, "topic", "title", "content");
		expect(id1).toBe(id2);
	});
});
