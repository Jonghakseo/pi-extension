import { describe, expect, it } from "vitest";
import {
	expandTabs,
	extensionName,
	isLikelySessionId,
	joinComma,
	joinCommaStyled,
	normalizeRemoteUrl,
	normalizeSkillName,
	normalizeText,
	normalizeWhitespace,
	sanitizeStatusText,
	sanitizeTopic,
	shortHash,
	slugToHeading,
	splitNullSeparated,
	toBase64,
	truncateTitle,
} from "./string-utils.ts";

// ── sanitizeTopic ────────────────────────────────────────────────────────────

describe("sanitizeTopic", () => {
	it("should lowercase and slugify", () => {
		expect(sanitizeTopic("My Topic")).toBe("my-topic");
	});

	it("should strip path traversal", () => {
		expect(sanitizeTopic("../../../etc/passwd")).toBe("etcpasswd");
	});

	it("should strip path separators", () => {
		// After stripping / and \, "foobarbaz" has no special chars → no hyphens
		expect(sanitizeTopic("foo/bar\\baz")).toBe("foobarbaz");
	});

	it("should handle Korean characters", () => {
		expect(sanitizeTopic("한글주제")).toBe("한글주제");
	});

	it("should throw on empty result", () => {
		expect(() => sanitizeTopic("!!!")).toThrow("Invalid topic name");
	});

	it("should collapse multiple hyphens", () => {
		expect(sanitizeTopic("a---b")).toBe("a-b");
	});

	it("should trim leading/trailing hyphens", () => {
		expect(sanitizeTopic("-hello-")).toBe("hello");
	});

	it("should truncate to 50 chars", () => {
		const long = "a".repeat(100);
		expect(sanitizeTopic(long).length).toBeLessThanOrEqual(50);
	});
});

// ── normalizeText ────────────────────────────────────────────────────────────

describe("normalizeText", () => {
	it("should trim whitespace", () => {
		expect(normalizeText("  hello  ")).toBe("hello");
	});

	it("should normalize CRLF to LF", () => {
		expect(normalizeText("a\r\nb\r\nc")).toBe("a\nb\nc");
	});

	it("should handle empty string", () => {
		expect(normalizeText("")).toBe("");
	});

	it("should handle only whitespace", () => {
		expect(normalizeText("   \r\n  ")).toBe("");
	});
});

// ── normalizeRemoteUrl ───────────────────────────────────────────────────────

describe("normalizeRemoteUrl", () => {
	it("should normalize HTTPS URL", () => {
		expect(normalizeRemoteUrl("https://github.com/example/product.git")).toBe("github-com-example-product");
	});

	it("should normalize SSH URL", () => {
		expect(normalizeRemoteUrl("git@github.com:example/product.git")).toBe("github-com-example-product");
	});

	it("should strip trailing slashes", () => {
		expect(normalizeRemoteUrl("https://github.com/org/repo///")).toBe("github-com-org-repo");
	});

	it("should handle bare domain", () => {
		expect(normalizeRemoteUrl("github.com/org/repo")).toBe("github-com-org-repo");
	});

	it("should handle empty/whitespace", () => {
		expect(normalizeRemoteUrl("   ")).toBe("");
	});
});

// ── shortHash ────────────────────────────────────────────────────────────────

describe("shortHash", () => {
	it("should return 8 hex characters", () => {
		const result = shortHash("test");
		expect(result).toMatch(/^[0-9a-f]{8}$/);
	});

	it("should be deterministic", () => {
		expect(shortHash("hello")).toBe(shortHash("hello"));
	});

	it("should differ for different inputs", () => {
		expect(shortHash("a")).not.toBe(shortHash("b"));
	});

	it("should handle empty string", () => {
		const result = shortHash("");
		expect(result).toMatch(/^[0-9a-f]{8}$/);
	});
});

// ── truncateTitle ────────────────────────────────────────────────────────────

describe("truncateTitle", () => {
	it("should return short content unchanged", () => {
		expect(truncateTitle("short")).toBe("short");
	});

	it("should truncate with ellipsis", () => {
		const long = "a".repeat(100);
		const result = truncateTitle(long, 60);
		expect(result.length).toBe(60);
		expect(result.endsWith("…")).toBe(true);
	});

	it("should use first line only", () => {
		expect(truncateTitle("first line\nsecond line")).toBe("first line");
	});

	it("should trim whitespace", () => {
		expect(truncateTitle("  hello  ")).toBe("hello");
	});

	it("should handle custom maxLen", () => {
		const result = truncateTitle("abcdefghij", 5);
		expect(result.length).toBe(5);
		expect(result).toBe("abcd…");
	});
});

// ── slugToHeading ────────────────────────────────────────────────────────────

describe("slugToHeading", () => {
	it("should convert slug to title case", () => {
		expect(slugToHeading("my-topic")).toBe("My Topic");
	});

	it("should handle single word", () => {
		expect(slugToHeading("general")).toBe("General");
	});

	it("should handle empty string", () => {
		expect(slugToHeading("")).toBe("");
	});

	it("should handle multi-word slug", () => {
		expect(slugToHeading("long-topic-name-here")).toBe("Long Topic Name Here");
	});
});

// ── splitNullSeparated ───────────────────────────────────────────────────────

describe("splitNullSeparated", () => {
	it("should split by null char", () => {
		expect(splitNullSeparated("a\0b\0c")).toEqual(["a", "b", "c"]);
	});

	it("should filter empty strings", () => {
		expect(splitNullSeparated("\0a\0\0b\0")).toEqual(["a", "b"]);
	});

	it("should handle empty input", () => {
		expect(splitNullSeparated("")).toEqual([]);
	});

	it("should handle single entry", () => {
		expect(splitNullSeparated("hello")).toEqual(["hello"]);
	});
});

// ── toBase64 ─────────────────────────────────────────────────────────────────

describe("toBase64", () => {
	it("should encode simple text", () => {
		expect(toBase64("hello")).toBe(Buffer.from("hello").toString("base64"));
	});

	it("should handle empty string", () => {
		expect(toBase64("")).toBe("");
	});

	it("should handle Korean text", () => {
		const result = toBase64("한글");
		expect(Buffer.from(result, "base64").toString("utf-8")).toBe("한글");
	});

	it("should handle special characters", () => {
		const result = toBase64("<script>alert('xss')</script>");
		expect(Buffer.from(result, "base64").toString("utf-8")).toBe("<script>alert('xss')</script>");
	});
});

// ── normalizeSkillName ───────────────────────────────────────────────────────

describe("normalizeSkillName", () => {
	it("should strip skill: prefix", () => {
		expect(normalizeSkillName("skill:todo")).toBe("todo");
	});

	it("should leave non-prefixed names unchanged", () => {
		expect(normalizeSkillName("todo")).toBe("todo");
	});

	it("should handle empty string", () => {
		expect(normalizeSkillName("")).toBe("");
	});

	it("should only strip first occurrence", () => {
		expect(normalizeSkillName("skill:skill:nested")).toBe("skill:nested");
	});
});

// ── joinComma ────────────────────────────────────────────────────────────────

describe("joinComma", () => {
	it("should join with comma and space", () => {
		expect(joinComma(["a", "b", "c"])).toBe("a, b, c");
	});

	it("should handle single item", () => {
		expect(joinComma(["only"])).toBe("only");
	});

	it("should handle empty array", () => {
		expect(joinComma([])).toBe("");
	});
});

// ── joinCommaStyled ──────────────────────────────────────────────────────────

describe("joinCommaStyled", () => {
	it("should apply render function and join", () => {
		const result = joinCommaStyled(["a", "b"], (s) => `[${s}]`, " | ");
		expect(result).toBe("[a] | [b]");
	});

	it("should handle empty array", () => {
		const result = joinCommaStyled([], (s) => s, ", ");
		expect(result).toBe("");
	});
});

// ── expandTabs ───────────────────────────────────────────────────────────────

describe("expandTabs", () => {
	it("should expand tabs to 4 spaces by default", () => {
		expect(expandTabs("\thello")).toBe("    hello");
	});

	it("should expand tabs with custom size", () => {
		expect(expandTabs("\thello", 2)).toBe("  hello");
	});

	it("should handle multiple tabs", () => {
		expect(expandTabs("\t\thello")).toBe("        hello");
	});

	it("should handle no tabs", () => {
		expect(expandTabs("hello")).toBe("hello");
	});

	it("should handle empty string", () => {
		expect(expandTabs("")).toBe("");
	});
});

// ── extensionName ────────────────────────────────────────────────────────────

describe("extensionName", () => {
	it("should extract name from file path", () => {
		expect(extensionName("/path/to/footer.ts")).toBe("footer");
	});

	it("should extract name from file:// URL", () => {
		expect(extensionName("file:///path/to/footer.ts")).toBe("footer");
	});

	it("should handle .js extension", () => {
		expect(extensionName("/path/foo.js")).toBe("foo");
	});
});

// ── normalizeWhitespace ──────────────────────────────────────────────────────

describe("normalizeWhitespace", () => {
	it("should collapse whitespace", () => {
		expect(normalizeWhitespace("  hello   world  ")).toBe("hello world");
	});

	it("should handle newlines and tabs", () => {
		expect(normalizeWhitespace("hello\n\tworld")).toBe("hello world");
	});

	it("should return empty for non-string", () => {
		expect(normalizeWhitespace(null)).toBe("");
		expect(normalizeWhitespace(undefined)).toBe("");
		expect(normalizeWhitespace(42)).toBe("");
	});

	it("should handle empty string", () => {
		expect(normalizeWhitespace("")).toBe("");
	});

	it("should handle Korean text", () => {
		expect(normalizeWhitespace("  안녕   하세요  ")).toBe("안녕 하세요");
	});
});

// ── sanitizeStatusText ───────────────────────────────────────────────────────

describe("sanitizeStatusText", () => {
	it("should replace newlines and tabs", () => {
		expect(sanitizeStatusText("hello\nworld\ttab")).toBe("hello world tab");
	});

	it("should collapse spaces", () => {
		expect(sanitizeStatusText("a   b")).toBe("a b");
	});

	it("should trim", () => {
		expect(sanitizeStatusText("  hello  ")).toBe("hello");
	});

	it("should handle empty string", () => {
		expect(sanitizeStatusText("")).toBe("");
	});

	it("should handle CR", () => {
		expect(sanitizeStatusText("a\rb")).toBe("a b");
	});
});

// ── isLikelySessionId ────────────────────────────────────────────────────────

describe("isLikelySessionId", () => {
	it("should detect hex session IDs", () => {
		expect(isLikelySessionId("1234567890abcdef1234")).toBe(true);
	});

	it("should detect session-NNN pattern", () => {
		expect(isLikelySessionId("session-123")).toBe(true);
		expect(isLikelySessionId("session42")).toBe(true);
	});

	it("should return true for empty/whitespace", () => {
		expect(isLikelySessionId("")).toBe(true);
		expect(isLikelySessionId("   ")).toBe(true);
	});

	it("should return false for normal text", () => {
		expect(isLikelySessionId("My cool project")).toBe(false);
		expect(isLikelySessionId("refactor-auth")).toBe(false);
	});

	it("should detect UUID-like session IDs", () => {
		expect(isLikelySessionId("session-abcdef12-3456-7890")).toBe(true);
	});

	it("should handle Korean text", () => {
		expect(isLikelySessionId("한글 세션")).toBe(false);
	});
});
