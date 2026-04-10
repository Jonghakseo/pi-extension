import { completeSimple } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateShortLabel, type ShortLabelContext } from "./short-label.ts";

vi.mock("@mariozechner/pi-ai", () => ({
	completeSimple: vi.fn(),
}));

const model = { id: "test-model" } as NonNullable<ShortLabelContext["model"]>;
type CompleteSimpleResult = Awaited<ReturnType<typeof completeSimple>>;

describe("generateShortLabel", () => {
	beforeEach(() => {
		vi.mocked(completeSimple).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns an empty string when model information or auth is unavailable", async () => {
		expect(
			await generateShortLabel(
				{},
				{
					systemPrompt: "system",
					prompt: "prompt",
				},
			),
		).toBe("");

		const label = await generateShortLabel(
			{
				model,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: false }),
				},
			},
			{
				systemPrompt: "system",
				prompt: "prompt",
			},
		);

		expect(label).toBe("");
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("returns extracted text for successful completions", async () => {
		vi.mocked(completeSimple).mockResolvedValue({
			stopReason: "stop",
			content: [
				{ type: "text", text: "first" },
				{ type: "text", text: " second" },
			],
		} as CompleteSimpleResult);

		const label = await generateShortLabel(
			{
				model,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
				},
			},
			{
				systemPrompt: "system",
				prompt: "prompt",
			},
		);

		expect(label).toBe("first second");
		expect(completeSimple).toHaveBeenCalledTimes(1);
	});

	it("ignores incomplete model responses", async () => {
		vi.mocked(completeSimple).mockResolvedValue({
			stopReason: "length",
			content: [{ type: "text", text: "ignored" }],
		} as CompleteSimpleResult);

		const label = await generateShortLabel(
			{
				model,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
				},
			},
			{
				systemPrompt: "system",
				prompt: "prompt",
			},
		);

		expect(label).toBe("");
	});

	it("falls back to the default text extractor and handles provider errors", async () => {
		vi.mocked(completeSimple)
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{ type: "image", text: "ignored" },
					{ type: "text", text: " label " },
				],
			} as CompleteSimpleResult)
			.mockRejectedValueOnce(new Error("network"));

		const ctx = {
			model,
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: { foo: "bar" } }),
			},
		};

		const label = await generateShortLabel(ctx, {
			systemPrompt: "system",
			prompt: "prompt",
			maxTokens: 10,
		});
		const failed = await generateShortLabel(ctx, {
			systemPrompt: "system",
			prompt: "prompt",
		});

		expect(label).toBe("label");
		expect(failed).toBe("");
	});

	it("aborts when the timeout elapses", async () => {
		vi.useFakeTimers();
		vi.mocked(completeSimple).mockImplementation(
			async (_model, _context, options) =>
				new Promise((_, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);

		const promise = generateShortLabel(
			{
				model,
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
				},
			},
			{
				systemPrompt: "system",
				prompt: "prompt",
				timeoutMs: 5,
			},
		);

		await vi.advanceTimersByTimeAsync(5);
		await expect(promise).resolves.toBe("");
	});
});
