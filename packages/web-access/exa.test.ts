import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalKey = process.env.EXA_API_KEY;
let home: string;

async function loadExa() {
	vi.resetModules();
	return import("./exa.js");
}

function lastBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
	const init = fetchMock.mock.calls.at(-1)?.[1] as { body: string };
	return JSON.parse(init.body);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "web-access-exa-"));
	process.env.HOME = home;
	delete process.env.EXA_API_KEY;
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env.HOME = originalHome;
	if (originalKey === undefined) delete process.env.EXA_API_KEY;
	else process.env.EXA_API_KEY = originalKey;
	rmSync(home, { recursive: true, force: true });
});

describe("Exa category", () => {
	it("sends category in the search body when an API key is set", async () => {
		process.env.EXA_API_KEY = "test-key";
		const fetchMock = vi.fn(async (..._args: unknown[]) =>
			Response.json({ results: [{ title: "Paper", url: "https://example.com/p" }] }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { searchWithExa } = await loadExa();

		const result = await searchWithExa("transformers", { category: "research paper" });

		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.exa.ai/search");
		expect(lastBody(fetchMock)).toMatchObject({ query: "transformers", category: "research paper" });
		expect(result).toMatchObject({ results: [{ url: "https://example.com/p" }] });
	});

	it("omits category from the body when none is given", async () => {
		process.env.EXA_API_KEY = "test-key";
		const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ results: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const { searchWithExa } = await loadExa();

		await searchWithExa("q", { recencyFilter: "week" });

		expect(lastBody(fetchMock)).not.toHaveProperty("category");
	});

	it("appends category to the query text on the keyless MCP path", async () => {
		const sse = `data: ${JSON.stringify({
			result: { content: [{ type: "text", text: "Title: News item\nURL: https://example.com/n\nText: body" }] },
		})}\n`;
		const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(sse));
		vi.stubGlobal("fetch", fetchMock);
		const { searchWithExa } = await loadExa();

		await searchWithExa("election results", { category: "news" });

		const args = (lastBody(fetchMock).params as { arguments: Record<string, unknown> }).arguments;
		expect(args.query).toBe("election results news");
		expect(args).not.toHaveProperty("category");
	});
});
