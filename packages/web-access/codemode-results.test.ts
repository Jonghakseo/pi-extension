import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerContentTools } from "./content-tools.js";
import { fetchAllContent } from "./extract.js";
import { search } from "./search.js";
import { clearResults, getResult } from "./storage.js";
import { registerWebSearchTool } from "./web-search-tool.js";

vi.mock("./search.js", () => ({ search: vi.fn() }));
vi.mock("./extract.js", () => ({ fetchAllContent: vi.fn() }));

type ToolResult = {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: unknown;
	details: Record<string, unknown>;
};
type Tool = {
	name: string;
	outputSchema?: unknown;
	execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};
type Handler = (event: Record<string, unknown>) => void;

function setup() {
	const tools: Record<string, Tool> = {};
	const handlers: Record<string, Handler[]> = {};
	const pi = {
		registerTool: (tool: Tool) => {
			tools[tool.name] = tool;
		},
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		on: (name: string, handler: Handler) => {
			handlers[name] = [...(handlers[name] ?? []), handler];
		},
	} as unknown as ExtensionAPI;
	registerWebSearchTool(pi);
	registerContentTools(pi);
	// Pi emits tool_call for a call a codemode script made, with parentToolCallId set, before execute.
	const emitNestedCall = (toolName: string, toolCallId: string) => {
		for (const handler of handlers.tool_call ?? []) {
			handler({ type: "tool_call", toolName, toolCallId, parentToolCallId: "script", input: {} });
		}
	};
	return { tools, emitNestedCall };
}

const searchMock = vi.mocked(search);
const fetchMock = vi.mocked(fetchAllContent);
const hit = { title: "Alpha", url: "https://example.com/a", snippet: "About alpha" };
const longBody = "Long page line.\n".repeat(3000);

describe("structured results for codemode scripts", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		clearResults();
	});

	it("declares an output schema on both tools", () => {
		const { tools } = setup();
		expect(tools.web_search.outputSchema).toBeDefined();
		expect(tools.fetch_content.outputSchema).toBeDefined();
	});

	it("web_search returns per-query results and errors as structuredContent", async () => {
		searchMock.mockResolvedValueOnce({ answer: "ans", results: [hit], provider: "exa" });
		searchMock.mockRejectedValueOnce(new Error("provider down"));
		const { tools } = setup();
		const result = await tools.web_search.execute("1", { queries: ["alpha", "beta"] });
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			responseId: result.details.searchId,
			fetchId: null,
			queries: [
				{ query: "alpha", answer: "ans", error: null, provider: "exa", results: [hit] },
				{ query: "beta", answer: "", error: "provider down", results: [] },
			],
		});
	});

	it("web_search keeps structuredContent when every query fails", async () => {
		searchMock.mockRejectedValue(new Error("boom"));
		const { tools } = setup();
		const result = await tools.web_search.execute("1", { query: "alpha" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({ queries: [{ query: "alpha", error: "boom", results: [] }] });
	});

	it("web_search without a query carries no structuredContent", async () => {
		const { tools } = setup();
		const result = await tools.web_search.execute("1", {});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
	});

	it("a top-level includeContent search fetches in the background", async () => {
		searchMock.mockResolvedValue({ answer: "", results: [hit], provider: "exa" });
		fetchMock.mockResolvedValue([{ url: hit.url, title: "A", content: "page", error: null }]);
		const { tools } = setup();
		const result = await tools.web_search.execute("1", { query: "alpha", includeContent: true });
		expect(result.details.fetchUrls).toEqual([hit.url]);
		expect(result.content[0].text).toContain("fetching in background");
	});

	it("a nested includeContent search waits for the page fetch", async () => {
		searchMock.mockResolvedValue({ answer: "", results: [hit], provider: "exa" });
		fetchMock.mockResolvedValue([{ url: hit.url, title: "A", content: "page", error: null }]);
		const { tools, emitNestedCall } = setup();
		emitNestedCall("web_search", "script/1");
		const result = await tools.web_search.execute("script/1", { query: "alpha", includeContent: true });
		expect(result.details.fetchUrls).toBeUndefined();
		const data = result.structuredContent as { fetchId: string | null };
		expect(data.fetchId).toBe(result.details.fetchId);
		expect(data.fetchId).not.toBeNull();
		expect(result.content[0].text).toContain("Full content for 1 sources");
		expect(getResult(data.fetchId as string)).toMatchObject({
			type: "fetch",
			urls: [expect.objectContaining({ url: hit.url, content: "page" })],
		});
	});

	it("a nested call id only applies to that call", async () => {
		searchMock.mockResolvedValue({ answer: "", results: [hit], provider: "exa" });
		fetchMock.mockResolvedValue([{ url: hit.url, title: "A", content: "page", error: null }]);
		const { tools, emitNestedCall } = setup();
		emitNestedCall("web_search", "script/1");
		await tools.web_search.execute("script/1", { query: "alpha" });
		const again = await tools.web_search.execute("script/1", { query: "alpha", includeContent: true });
		expect(again.details.fetchUrls).toEqual([hit.url]);
	});

	it("a call from another tool to a different tool name is not treated as nested", async () => {
		searchMock.mockResolvedValue({ answer: "", results: [hit], provider: "exa" });
		const { tools, emitNestedCall } = setup();
		emitNestedCall("fetch_content", "script/2");
		const result = await tools.web_search.execute("script/2", { query: "alpha", includeContent: true });
		expect(result.details.fetchUrls).toEqual([hit.url]);
	});

	it("fetch_content returns full content per URL past the inline cap, model text stays capped", async () => {
		fetchMock.mockResolvedValue([
			{ url: "https://example.com/long", title: "Long", content: longBody, error: null },
			{ url: "https://example.com/short", title: "Short", content: "Short page.", error: null },
		]);
		const { tools } = setup();
		const result = await tools.fetch_content.execute("1", {
			urls: ["https://example.com/long", "https://example.com/short"],
		});
		const data = result.structuredContent as { responseId: string; urls: Array<{ url: string; content: string }> };
		expect(data.responseId).toBe(result.details.responseId);
		expect(data.urls.map((u) => u.content)).toEqual([longBody, "Short page."]);
		expect(result.content[0].text).not.toContain("Long page line.");
	});

	it("fetch_content returns the full body of a single URL while the text output is truncated", async () => {
		fetchMock.mockResolvedValue([{ url: "https://example.com/long", title: "Long", content: longBody, error: null }]);
		const { tools } = setup();
		const result = await tools.fetch_content.execute("1", { url: "https://example.com/long" });
		expect(result.details.truncated).toBe(true);
		const data = result.structuredContent as { urls: Array<{ content: string }> };
		expect(data.urls[0].content).toBe(longBody);
	});

	it("fetch_content keeps structuredContent with the error when a URL fails", async () => {
		fetchMock.mockResolvedValue([{ url: "https://example.com/x", title: "", content: "", error: "HTTP 403" }]);
		const { tools } = setup();
		const result = await tools.fetch_content.execute("1", { url: "https://example.com/x" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			urls: [{ url: "https://example.com/x", content: "", error: "HTTP 403" }],
		});
	});

	it("fetch_content without a URL carries no structuredContent", async () => {
		const { tools } = setup();
		const result = await tools.fetch_content.execute("1", {});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
	});
});
