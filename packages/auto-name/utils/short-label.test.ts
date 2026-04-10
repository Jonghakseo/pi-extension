import { completeSimple } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

	it("returns an empty string when model auth is unavailable", async () => {
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
});
