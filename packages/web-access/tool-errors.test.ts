import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerContentTools } from "./content-tools.js";
import { fetchAllContent } from "./extract.js";
import { search } from "./search.js";
import { clearResults, storeResult } from "./storage.js";
import { registerWebSearchTool } from "./web-search-tool.js";

vi.mock("./search.js", () => ({ search: vi.fn() }));
vi.mock("./extract.js", () => ({ fetchAllContent: vi.fn() }));

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult> };

function collectTools(register: (pi: ExtensionAPI) => void): Record<string, Tool> {
	const tools: Record<string, Tool> = {};
	register({
		registerTool: (tool: Tool) => {
			tools[tool.name] = tool;
		},
		appendEntry: () => {},
		on: () => {},
	} as unknown as ExtensionAPI);
	return tools;
}

const searchMock = vi.mocked(search);
const fetchMock = vi.mocked(fetchAllContent);

const page = (url: string, error: string | null = null) => ({ url, title: "T", content: error ? "" : "body", error });

describe("web_search error flag", () => {
	const { web_search } = collectTools(registerWebSearchTool);

	beforeEach(() => vi.resetAllMocks());

	it("marks a call without any query as an error", async () => {
		const result = await web_search.execute("1", {});
		expect(result.isError).toBe(true);
	});

	it("marks the result as an error when every query fails", async () => {
		searchMock.mockRejectedValue(new Error("boom"));
		const result = await web_search.execute("1", { queries: ["a", "b"] });
		expect(result.isError).toBe(true);
	});

	it("does not mark a partial failure as an error", async () => {
		searchMock.mockRejectedValueOnce(new Error("boom"));
		searchMock.mockResolvedValueOnce({ answer: "", results: [], provider: "exa" });
		const result = await web_search.execute("1", { queries: ["a", "b"] });
		expect(result.isError).toBeUndefined();
	});

	it("does not mark a successful search with no matches as an error", async () => {
		searchMock.mockResolvedValue({ answer: "", results: [], provider: "exa" });
		const result = await web_search.execute("1", { query: "a" });
		expect(result.isError).toBeUndefined();
	});
});

describe("fetch_content error flag", () => {
	const { fetch_content } = collectTools(registerContentTools);

	beforeEach(() => vi.resetAllMocks());

	it("tells the model which parameters to use when no URL is given", async () => {
		const result = await fetch_content.execute("1", {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("'url'");
		expect(result.content[0].text).toContain("'urls'");
	});

	it("marks a failed single URL as an error", async () => {
		fetchMock.mockResolvedValue([page("https://a.test", "HTTP 500")] as never);
		const result = await fetch_content.execute("1", { url: "https://a.test" });
		expect(result.isError).toBe(true);
	});

	it("marks the result as an error when every URL fails", async () => {
		fetchMock.mockResolvedValue([page("https://a.test", "x"), page("https://b.test", "y")] as never);
		const result = await fetch_content.execute("1", { urls: ["https://a.test", "https://b.test"] });
		expect(result.isError).toBe(true);
	});

	it("does not mark a partial failure as an error", async () => {
		fetchMock.mockResolvedValue([page("https://a.test", "x"), page("https://b.test")] as never);
		const result = await fetch_content.execute("1", { urls: ["https://a.test", "https://b.test"] });
		expect(result.isError).toBeUndefined();
	});

	it("does not mark a successful single URL as an error", async () => {
		fetchMock.mockResolvedValue([page("https://a.test")] as never);
		const result = await fetch_content.execute("1", { url: "https://a.test" });
		expect(result.isError).toBeUndefined();
	});
});

describe("get_search_content error flag", () => {
	const { get_search_content } = collectTools(registerContentTools);

	beforeEach(() => clearResults());

	it("marks an unknown responseId as an error", async () => {
		const result = await get_search_content.execute("1", { responseId: "missing" });
		expect(result.isError).toBe(true);
	});

	it("marks an out-of-range index as an error", async () => {
		storeResult("r1", { id: "r1", type: "fetch", timestamp: Date.now(), urls: [page("https://a.test")] });
		const result = await get_search_content.execute("1", { responseId: "r1", urlIndex: 5 });
		expect(result.isError).toBe(true);
	});

	it("returns stored content without the error flag", async () => {
		storeResult("r2", { id: "r2", type: "fetch", timestamp: Date.now(), urls: [page("https://a.test")] });
		const result = await get_search_content.execute("1", { responseId: "r2", urlIndex: 0 });
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain("body");
	});
});
