import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { findContent } from "./content-find.js";
import { registerContentTools } from "./content-tools.js";
import { clearResults, storeResult } from "./storage.js";

type ToolResult = {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
};
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult> };

function getTool(): Tool {
	const tools: Record<string, Tool> = {};
	registerContentTools({
		registerTool: (tool: Tool) => {
			tools[tool.name] = tool;
		},
		appendEntry: () => {},
	} as unknown as ExtensionAPI);
	return tools.get_search_content;
}

const get = getTool();
const text = (result: ToolResult) => result.content[0].text ?? "";

function storeFetch(id: string, content: string) {
	storeResult(id, {
		id,
		type: "fetch",
		timestamp: Date.now(),
		urls: [{ url: "https://a.test", title: "Doc", content, error: null }],
	});
}

describe("get_search_content offset/limit", () => {
	beforeEach(() => clearResults());

	it("returns a slice and tells where the next one starts", async () => {
		storeFetch("r1", "0123456789".repeat(10));
		const result = await get.execute("1", { responseId: "r1", urlIndex: 0, offset: 10, limit: 20 });
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("0123456789".repeat(2));
		expect(text(result)).toContain("Showing chars 10-30 of 100");
		expect(text(result)).toContain("offset: 30");
		expect(result.details).toMatchObject({ offset: 10, returnedChars: 20, nextOffset: 30 });
	});

	it("omits the next-slice hint on the last slice", async () => {
		storeFetch("r1", "abcdef");
		const result = await get.execute("1", { responseId: "r1", urlIndex: 0, offset: 4 });
		expect(text(result)).toContain("ef");
		expect(text(result)).not.toContain("for the next slice");
		expect(result.details).toMatchObject({ nextOffset: null });
	});

	it("rejects an offset beyond the content", async () => {
		storeFetch("r1", "abc");
		const result = await get.execute("1", { responseId: "r1", urlIndex: 0, offset: 10 });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("out of range");
	});

	it("slices search results by queryIndex", async () => {
		storeResult("s1", {
			id: "s1",
			type: "search",
			timestamp: Date.now(),
			queries: [
				{
					query: "q",
					answer: "",
					provider: "exa",
					results: [{ title: "Title", url: "https://x.test", snippet: "" }],
					error: null,
				},
			],
		});
		const result = await get.execute("1", { responseId: "s1", queryIndex: 0, limit: 10 });
		expect(text(result)).toContain("queryIndex: 0, offset: 10");
	});
});

describe("get_search_content findText", () => {
	beforeEach(() => clearResults());

	const page = `${"filler ".repeat(200)}The Timeout setting controls retries.${" filler".repeat(200)}`;

	it("returns the matching passage with context and a match count", async () => {
		storeFetch("r1", page);
		const result = await get.execute("1", { responseId: "r1", urlIndex: 0, findText: "timeout" });
		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("Text matches (case-insensitive)");
		expect(text(result)).toContain("The Timeout setting controls retries.");
		expect(text(result).length).toBeLessThan(page.length);
		expect(result.details).toMatchObject({ matchCount: 1, returnedMatches: 1 });
	});

	it("honors exact mode case sensitivity", async () => {
		storeFetch("r1", page);
		const result = await get.execute("1", { responseId: "r1", urlIndex: 0, findText: "timeout", findMode: "exact" });
		expect(text(result)).toContain("no matches");
		expect(result.details).toMatchObject({ matchCount: 0 });
	});

	it("finds a misspelled word in fuzzy mode", async () => {
		storeFetch("r1", page);
		const result = await get.execute("1", {
			responseId: "r1",
			urlIndex: 0,
			findText: ["settting"],
			findMode: "fuzzy",
		});
		expect(result.details).toMatchObject({ matchCount: 1 });
	});

	it("reports per-query match counts for several queries", async () => {
		storeFetch("r1", page);
		const result = await get.execute("1", { responseId: "r1", urlIndex: 0, findText: ["retries", "missing-word"] });
		expect(result.details).toMatchObject({
			queryResults: [
				{ query: "retries", matchCount: 1 },
				{ query: "missing-word", matchCount: 0 },
			],
		});
		expect(text(result)).toContain('No matches: "missing-word"');
	});

	it("caps the output at 20,000 characters", async () => {
		storeFetch("r1", "needle and some padding text. ".repeat(5000));
		const result = await get.execute("1", { responseId: "r1", urlIndex: 0, findText: "needle" });
		expect(text(result).length).toBeLessThanOrEqual(20_100);
		expect(text(result)).toContain("Showing");
		expect((result.details as { matchCount: number }).matchCount).toBe(5000);
	});

	it("stays within 20,000 characters when 900 matches each carry ellipses", () => {
		const text = Array.from({ length: 900 }, (_, i) => `${"filler ".repeat(300)}needle${i}`).join(" ");
		const result = findContent(text, ["needle"], "case-insensitive");
		expect(result.matchCount).toBe(900);
		expect(result.text.length).toBeLessThanOrEqual(20_000);
	});

	it("rejects findText combined with offset or limit", async () => {
		storeFetch("r1", page);
		for (const extra of [{ offset: 5 }, { limit: 5 }]) {
			const result = await get.execute("1", { responseId: "r1", urlIndex: 0, findText: "x", ...extra });
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("cannot be combined");
		}
	});

	it("rejects findMode without findText", async () => {
		storeFetch("r1", page);
		const result = await get.execute("1", { responseId: "r1", urlIndex: 0, findMode: "fuzzy" });
		expect(result.isError).toBe(true);
	});
});
