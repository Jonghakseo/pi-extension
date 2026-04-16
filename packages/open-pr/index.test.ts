import { describe, expect, it } from "vitest";
import { formatPrLookupError, parsePrViewUrl, resolveBrowserOpenCommand } from "./index.ts";

// ---------------------------------------------------------------------------
// parsePrViewUrl — extract URL from gh pr view JSON output
// ---------------------------------------------------------------------------

describe("parsePrViewUrl", () => {
	it("should extract url from valid JSON", () => {
		const stdout = JSON.stringify({ url: "https://github.com/owner/repo/pull/42" });
		expect(parsePrViewUrl(stdout)).toBe("https://github.com/owner/repo/pull/42");
	});

	it("should trim whitespace from url", () => {
		const stdout = JSON.stringify({ url: "  https://github.com/owner/repo/pull/1  " });
		expect(parsePrViewUrl(stdout)).toBe("https://github.com/owner/repo/pull/1");
	});

	it("should return null for empty string input", () => {
		expect(parsePrViewUrl("")).toBeNull();
	});

	it("should return null for non-JSON input", () => {
		expect(parsePrViewUrl("not json at all")).toBeNull();
	});

	it("should return null when url field is missing", () => {
		const stdout = JSON.stringify({ title: "some PR" });
		expect(parsePrViewUrl(stdout)).toBeNull();
	});

	it("should return null when url is not a string", () => {
		const stdout = JSON.stringify({ url: 123 });
		expect(parsePrViewUrl(stdout)).toBeNull();
	});

	it("should return null when url is empty string", () => {
		const stdout = JSON.stringify({ url: "" });
		expect(parsePrViewUrl(stdout)).toBeNull();
	});

	it("should return null when url is whitespace-only", () => {
		const stdout = JSON.stringify({ url: "   " });
		expect(parsePrViewUrl(stdout)).toBeNull();
	});

	it("should return null when url is null", () => {
		const stdout = JSON.stringify({ url: null });
		expect(parsePrViewUrl(stdout)).toBeNull();
	});

	it("should handle JSON with extra fields", () => {
		const stdout = JSON.stringify({
			url: "https://github.com/owner/repo/pull/99",
			title: "feat: something",
			state: "OPEN",
		});
		expect(parsePrViewUrl(stdout)).toBe("https://github.com/owner/repo/pull/99");
	});
});

// ---------------------------------------------------------------------------
// resolveBrowserOpenCommand — platform-specific browser command
// ---------------------------------------------------------------------------

describe("resolveBrowserOpenCommand", () => {
	const url = "https://github.com/owner/repo/pull/42";

	it("should return 'open' command on darwin", () => {
		const result = resolveBrowserOpenCommand("darwin", url);
		expect(result).toEqual({ command: "open", args: [url] });
	});

	it("should return 'cmd /c start' on win32", () => {
		const result = resolveBrowserOpenCommand("win32", url);
		expect(result).toEqual({ command: "cmd", args: ["/c", "start", "", url] });
	});

	it("should return 'xdg-open' on linux", () => {
		const result = resolveBrowserOpenCommand("linux", url);
		expect(result).toEqual({ command: "xdg-open", args: [url] });
	});

	it("should fall back to xdg-open for unknown platforms", () => {
		const result = resolveBrowserOpenCommand("freebsd" as NodeJS.Platform, url);
		expect(result).toEqual({ command: "xdg-open", args: [url] });
	});

	it("should pass the exact url in args", () => {
		const specialUrl = "https://github.com/owner/repo/pull/1?query=a&b=c#hash";
		const result = resolveBrowserOpenCommand("darwin", specialUrl);
		expect(result.args).toContain(specialUrl);
	});
});

// ---------------------------------------------------------------------------
// formatPrLookupError — error message formatting for gh CLI errors
// ---------------------------------------------------------------------------

describe("formatPrLookupError", () => {
	describe("no PR found", () => {
		it("should format 'no pull requests found' with branch", () => {
			const msg = formatPrLookupError("no pull requests found for branch", "feat/login");
			expect(msg).toBe("No pull request found for the current branch (feat/login).");
		});

		it("should format 'no pull requests found' without branch", () => {
			const msg = formatPrLookupError("no pull requests found for branch", null);
			expect(msg).toBe("No pull request found for the current branch.");
		});

		it("should be case-insensitive", () => {
			const msg = formatPrLookupError("No Pull Requests Found", "main");
			expect(msg).toBe("No pull request found for the current branch (main).");
		});
	});

	describe("authentication failures", () => {
		it("should handle 'not logged into any github hosts'", () => {
			const error = "not logged into any github hosts. Run gh auth login";
			const msg = formatPrLookupError(error, "main");
			expect(msg).toBe(`GitHub CLI authentication failed: ${error}`);
		});

		it("should handle 'authentication failed'", () => {
			const error = "authentication failed";
			const msg = formatPrLookupError(error, "main");
			expect(msg).toBe(`GitHub CLI authentication failed: ${error}`);
		});

		it("should handle 'gh auth login' hint", () => {
			const error = "To use GitHub CLI, run: gh auth login";
			const msg = formatPrLookupError(error, "main");
			expect(msg).toBe(`GitHub CLI authentication failed: ${error}`);
		});

		it("should handle 'authentication required'", () => {
			const error = "authentication required";
			const msg = formatPrLookupError(error, "main");
			expect(msg).toBe(`GitHub CLI authentication failed: ${error}`);
		});
	});

	describe("repository lookup failures", () => {
		it("should handle 'could not resolve to a repository'", () => {
			const error = "GraphQL: Could not resolve to a Repository";
			const msg = formatPrLookupError(error, "main");
			expect(msg).toBe(`GitHub repository lookup failed: ${error}`);
		});

		it("should handle 'failed to determine base repo'", () => {
			const error = "failed to determine base repo";
			const msg = formatPrLookupError(error, "main");
			expect(msg).toBe(`GitHub repository lookup failed: ${error}`);
		});

		it("should handle 'no git remotes found'", () => {
			const error = "no git remotes found";
			const msg = formatPrLookupError(error, "main");
			expect(msg).toBe(`GitHub repository lookup failed: ${error}`);
		});

		it("should handle 'not a git repository'", () => {
			const error = "not a git repository (or any parent up to mount point)";
			const msg = formatPrLookupError(error, "main");
			expect(msg).toBe(`GitHub repository lookup failed: ${error}`);
		});
	});

	describe("generic / fallback errors", () => {
		it("should include branch in generic error when available", () => {
			const msg = formatPrLookupError("something unexpected happened", "feat/x");
			expect(msg).toBe("Failed to resolve pull request for feat/x: something unexpected happened");
		});

		it("should omit branch in generic error when null", () => {
			const msg = formatPrLookupError("something unexpected happened", null);
			expect(msg).toBe("Failed to resolve pull request: something unexpected happened");
		});

		it("should use 'Unknown gh error' for empty error", () => {
			const msg = formatPrLookupError("", "main");
			expect(msg).toBe("Failed to resolve pull request for main: Unknown gh error");
		});

		it("should use 'Unknown gh error' for whitespace-only error", () => {
			const msg = formatPrLookupError("   ", "main");
			expect(msg).toBe("Failed to resolve pull request for main: Unknown gh error");
		});
	});
});
