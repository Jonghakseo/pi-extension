import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasExaApiKey, searchWithExa } from "./exa.js";
import { searchWithOpenAI } from "./openai-search.js";
import { search } from "./search.js";
import { registerWebSearchTool } from "./web-search-tool.js";

vi.mock("./exa.js", () => ({
	hasExaApiKey: vi.fn(),
	searchWithExa: vi.fn(),
}));

vi.mock("./openai-search.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./openai-search.js")>()),
	searchWithOpenAI: vi.fn(),
}));

const openaiSearch = vi.mocked(searchWithOpenAI);
const codexCtx = { model: { provider: "openai-codex", id: "gpt-5.4" } } as never;
const otherCtx = { model: { provider: "anthropic", id: "claude" } } as never;
const exaSearch = vi.mocked(searchWithExa);
const hasKey = vi.mocked(hasExaApiKey);

describe("web search without Gemini", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("exposes provider auto/exa/openai", () => {
		let parameters: { properties: Record<string, unknown> } | undefined;
		registerWebSearchTool({
			registerTool: (tool: { parameters: { properties: Record<string, unknown> } }) => {
				parameters = tool.parameters;
			},
			on: () => {},
		} as unknown as ExtensionAPI);
		expect(parameters?.properties).toHaveProperty("provider");
		expect(JSON.stringify(parameters?.properties.provider)).toContain("openai");
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

	describe("provider routing", () => {
		const exaHit = { answer: "exa", results: [{ title: "E", url: "https://e.example", snippet: "" }] };
		const openaiHit = { answer: "openai", results: [{ title: "O", url: "https://o.example", snippet: "" }] };

		it("auto tries OpenAI first on a Codex subscription model", async () => {
			openaiSearch.mockResolvedValue(openaiHit);

			const result = await search("q", {}, codexCtx);

			expect(result).toMatchObject({ answer: "openai", provider: "openai" });
			expect(exaSearch).not.toHaveBeenCalled();
		});

		it("auto falls back to Exa when OpenAI fails", async () => {
			openaiSearch.mockRejectedValue(new Error("OpenAI API error 429"));
			exaSearch.mockResolvedValue(exaHit);

			await expect(search("q", {}, codexCtx)).resolves.toMatchObject({ provider: "exa" });
		});

		it("tells the model why auto fell back to Exa", async () => {
			openaiSearch.mockRejectedValue(new Error("OpenAI API error 429: quota exceeded"));
			exaSearch.mockResolvedValue(exaHit);

			const result = await search("q", {}, codexCtx);

			expect(result.provider).toBe("exa");
			expect(result.answer).toContain("OpenAI search failed (OpenAI API error 429: quota exceeded)");
			expect(result.answer).toContain("come from Exa");
			expect(result.answer.endsWith("exa")).toBe(true);
		});

		it("gives OpenAI 20s under auto but leaves an explicit openai request on its default timeout", async () => {
			openaiSearch.mockResolvedValue(openaiHit);

			await search("q", {}, codexCtx);
			await search("q", { provider: "openai" }, codexCtx);

			expect(openaiSearch.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 20_000 });
			expect(openaiSearch.mock.calls[1]?.[1]?.timeoutMs).toBeUndefined();
		});

		it("auto does not fall back after the caller aborts", async () => {
			const controller = new AbortController();
			openaiSearch.mockImplementation(async () => {
				controller.abort();
				throw new Error("aborted");
			});

			await expect(search("q", { signal: controller.signal }, codexCtx)).rejects.toThrow("aborted");
			expect(exaSearch).not.toHaveBeenCalled();
		});

		it("auto uses Exa only when the current model is not a Codex subscription model", async () => {
			exaSearch.mockResolvedValue(exaHit);

			await expect(search("q", {}, otherCtx)).resolves.toMatchObject({ provider: "exa" });
			await expect(search("q")).resolves.toMatchObject({ provider: "exa" });
			expect(openaiSearch).not.toHaveBeenCalled();
		});

		it("explicit openai has no Exa fallback", async () => {
			openaiSearch.mockRejectedValue(new Error("Sign in with /login"));

			await expect(search("q", { provider: "openai" }, otherCtx)).rejects.toThrow("/login");
			expect(exaSearch).not.toHaveBeenCalled();
		});

		it("explicit exa skips OpenAI even on a Codex model", async () => {
			exaSearch.mockResolvedValue(exaHit);

			await expect(search("q", { provider: "exa" }, codexCtx)).resolves.toMatchObject({ provider: "exa" });
			expect(openaiSearch).not.toHaveBeenCalled();
		});
	});
});
