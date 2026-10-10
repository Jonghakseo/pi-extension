import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setConfigPathForTests } from "./config.js";
import {
	isOpenAISubscriptionModelSelected,
	type OpenAISearchContext,
	pickSearchModel,
	searchWithOpenAI,
} from "./openai-search.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })}.sig`;

function codexContext(models: string[] = ["gpt-5.4", "gpt-6-luna", "gpt-6-pro"]): OpenAISearchContext {
	return {
		model: { provider: "openai-codex", id: "gpt-5.4" },
		modelRegistry: {
			getAll: () => [
				...models.map((id) => ({ provider: "openai-codex", id })),
				{ provider: "anthropic", id: "claude-zzz" },
			],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: TOKEN, headers: { "x-extra": "1" } }),
		},
	} as unknown as OpenAISearchContext;
}

function sse(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

const searchStream = () =>
	sse([
		{ type: "response.web_search_call.completed" },
		{
			type: "response.output_item.done",
			item: {
				type: "web_search_call",
				action: { sources: [{ url: "https://src.example/extra?utm_source=openai", title: "Extra" }] },
			},
		},
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Pi is a coding agent [Pi](https://pi.dev/?utm_source=openai).",
						annotations: [
							{
								type: "url_citation",
								url: "https://pi.dev/?utm_source=openai",
								title: "Pi",
								start_index: 5,
								end_index: 20,
							},
						],
					},
				],
			},
		},
		{ type: "response.completed", response: { output: [] } },
	]);

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-access-openai-"));
	setConfigPathForTests(join(dir, "web-search.json"));
});

afterEach(() => {
	vi.unstubAllGlobals();
	setConfigPathForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("searchWithOpenAI", () => {
	it("posts a hosted web_search request to the Codex endpoint with the subscription token", async () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => searchStream());
		vi.stubGlobal("fetch", fetchMock);

		const result = await searchWithOpenAI(
			"what is pi",
			{ recencyFilter: "week", domainFilter: ["pi.dev", "-spam.example.com"], numResults: 3 },
			codexContext(),
		);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			Authorization: `Bearer ${TOKEN}`,
			"chatgpt-account-id": "acct_123",
			originator: "pi",
			"x-extra": "1",
		});
		const body = JSON.parse(String(init.body));
		expect(body).toMatchObject({
			model: "gpt-6-luna",
			stream: true,
			store: false,
			tool_choice: "required",
			tools: [{ type: "web_search", filters: { allowed_domains: ["pi.dev"], blocked_domains: ["spam.example.com"] } }],
			input: [{ role: "user", content: [{ type: "input_text", text: "what is pi" }] }],
		});
		expect(body.instructions).toContain("past week");

		expect(result.answer).toContain("Pi is a coding agent");
		expect(result.results.map((r) => r.url)).toEqual(["https://pi.dev/", "https://src.example/extra"]);
		expect(result.results[0]?.snippet).toContain("coding agent");
	});

	it("uses openaiSearchModel from the config file when set", async () => {
		writeFileSync(join(dir, "web-search.json"), JSON.stringify({ openaiSearchModel: "gpt-5.4" }));
		setConfigPathForTests(join(dir, "web-search.json"));
		const fetchMock = vi.fn(async (..._args: unknown[]) => searchStream());
		vi.stubGlobal("fetch", fetchMock);

		await searchWithOpenAI("q", {}, codexContext());

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body)).model).toBe("gpt-5.4");
	});

	it("fails clearly without a Codex login and never calls the network", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const ctx = {
			model: { provider: "anthropic", id: "claude" },
			modelRegistry: {
				getAll: () => [{ provider: "openai-codex", id: "gpt-6-luna" }],
				getApiKeyAndHeaders: async () => ({ ok: false, error: "No credentials" }),
			},
		} as unknown as OpenAISearchContext;

		await expect(searchWithOpenAI("q", {}, ctx)).rejects.toThrow("/login");
		await expect(searchWithOpenAI("q")).rejects.toThrow("/login");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("redacts the token from HTTP error bodies", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(`bad token ${TOKEN}`, { status: 401 })),
		);

		const error = await searchWithOpenAI("q", {}, codexContext()).catch((err: Error) => err);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("401");
		expect((error as Error).message).not.toContain(TOKEN);
		expect((error as Error).message).toContain("[redacted]");
	});

	it("surfaces a mid-stream error event from an HTTP 200 response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => sse([{ type: "error", error: { code: "usage_limit_reached", message: "Quota used up" } }])),
		);

		await expect(searchWithOpenAI("q", {}, codexContext())).rejects.toThrow("usage_limit_reached");
	});

	it("rejects a response with no web_search_call", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				sse([
					{
						type: "response.output_item.done",
						item: { type: "message", content: [{ type: "output_text", text: "from memory", annotations: [] }] },
					},
				]),
			),
		);

		await expect(searchWithOpenAI("q", {}, codexContext())).rejects.toThrow("no web_search_call");
	});

	it("stops when the caller aborts", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		controller.abort();

		await expect(searchWithOpenAI("q", { signal: controller.signal }, codexContext())).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("model selection", () => {
	it("prefers luna, then the newest bare gpt id, and skips pro/ultra tiers", () => {
		const pick = (...ids: string[]) => pickSearchModel(ids.map((id) => ({ id })))?.id;
		expect(pick("gpt-5.9", "gpt-5.10", "gpt-6-luna", "gpt-7-pro")).toBe("gpt-6-luna");
		expect(pick("gpt-5.9", "gpt-5.10", "gpt-5.10-codex", "gpt-6-pro")).toBe("gpt-5.10");
		expect(pick("gpt-6-pro")).toBeUndefined();
	});

	it("treats only openai-codex models as a subscription model", () => {
		expect(isOpenAISubscriptionModelSelected({ model: { provider: "openai-codex" } } as never)).toBe(true);
		expect(isOpenAISubscriptionModelSelected({ model: { provider: "openai" } } as never)).toBe(false);
		expect(isOpenAISubscriptionModelSelected(undefined)).toBe(false);
	});
});
