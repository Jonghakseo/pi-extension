import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasExaApiKey, searchWithExa } from "./exa.js";
import { search } from "./search.js";
import { registerWebSearchTool } from "./web-search-tool.js";

vi.mock("./exa.js", () => ({
	hasExaApiKey: vi.fn(),
	searchWithExa: vi.fn(),
}));

const exaSearch = vi.mocked(searchWithExa);
const hasKey = vi.mocked(hasExaApiKey);

describe("web search without Gemini", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("does not expose a provider selection parameter", () => {
		let parameters: { properties: Record<string, unknown> } | undefined;
		registerWebSearchTool({
			registerTool: (tool: { parameters: { properties: Record<string, unknown> } }) => {
				parameters = tool.parameters;
			},
		} as unknown as ExtensionAPI);
		expect(parameters?.properties).not.toHaveProperty("provider");
	});

	it("returns Exa results without an API key", async () => {
		hasKey.mockReturnValue(false);
		exaSearch.mockResolvedValue({
			answer: "Answer",
			results: [{ title: "Source", url: "https://example.com", snippet: "" }],
		});

		await expect(search("question")).resolves.toEqual({
			answer: "Answer",
			results: [{ title: "Source", url: "https://example.com", snippet: "" }],
			provider: "exa",
		});
	});

	it("explains missing Exa access rather than suggesting a Gemini key", async () => {
		hasKey.mockReturnValue(false);
		exaSearch.mockResolvedValue(null);

		await expect(search("question")).rejects.toThrow("check Exa MCP access");
	});
});
