import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import askUserQuestionExtension, {
	AskUserQuestionParams,
	buildRenderCallText,
	buildRenderResultText,
	errorResult,
	normalizeQuestions,
} from "./index.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => `[${text}]`,
	bold: (text: string) => text,
} as const;

describe("ask-user-question extension", () => {
	it("exports helpers", () => {
		expect(AskUserQuestionParams).toBeTruthy();
		expect(errorResult("boom").content[0].text).toBe("boom");
		expect(normalizeQuestions([{ id: "x", type: "text", prompt: "Q" }])[0].label).toBe("Q1");
		expect(buildRenderCallText({ questions: [{ id: "x", type: "text", prompt: "Q" }] }, theme)).toContain("1개 문항");
		expect(buildRenderResultText({ content: [{ type: "text", text: "plain" }] }, theme)).toBe("plain");
	});

	it("returns errors when UI is unavailable or no questions are provided", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("ask_user_question");
		if (!tool.execute) throw new Error("execute is missing");

		const noUi = await tool.execute(
			"call-1",
			{ title: "Title", questions: [{ id: "x", type: "text", prompt: "Q" }] },
			undefined,
			undefined,
			{ hasUI: false } as unknown as ExtensionContext,
		);
		const noQuestions = await tool.execute("call-2", { title: "Title", questions: [] }, undefined, undefined, {
			hasUI: true,
			ui: { custom: vi.fn() },
		} as unknown as ExtensionContext);

		expect(noUi).toMatchObject({
			content: [{ type: "text", text: "오류: UI를 사용할 수 없습니다. 현재 비대화형 모드에서 실행 중입니다." }],
		});
		expect(noQuestions).toMatchObject({ content: [{ type: "text", text: "오류: 질문이 제공되지 않았습니다." }] });
	});

	it("returns cancelled and successful execution results", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("ask_user_question");
		if (!tool.execute || !tool.renderCall || !tool.renderResult) throw new Error("tool renderers are missing");

		const cancelledResult = await tool.execute(
			"call-3",
			{ title: "Title", questions: [{ id: "x", type: "text", prompt: "Q" }] },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: vi.fn(async () => ({
						title: "Title",
						questions: normalizeQuestions([{ id: "x", type: "text", prompt: "Q" }]),
						answers: [{ id: "x", type: "text", value: "", wasCustom: true }],
						cancelled: true,
					})),
				},
			} as unknown as ExtensionContext,
		);

		const successResult = await tool.execute(
			"call-4",
			{
				title: "Title",
				questions: [
					{ id: "x", type: "text", prompt: "Q" },
					{ id: "y", type: "checkbox", prompt: "Q2", options: [{ value: "a", label: "Alpha" }] },
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: vi.fn(async () => ({
						title: "Title",
						questions: normalizeQuestions([
							{ id: "x", type: "text", prompt: "Q" },
							{ id: "y", type: "checkbox", prompt: "Q2", options: [{ value: "a", label: "Alpha" }] },
						]),
						answers: [
							{ id: "x", type: "text", value: "hello", wasCustom: true },
							{ id: "y", type: "checkbox", value: ["a"], wasCustom: false },
						],
						cancelled: false,
					})),
				},
			} as unknown as ExtensionContext,
		);

		expect(cancelledResult).toMatchObject({ content: [{ type: "text", text: "사용자가 입력 폼을 취소했습니다" }] });
		expect(successResult).toMatchObject({ content: [{ type: "text", text: "Q1: hello\nQ2: a" }] });
		expect(
			tool.renderCall({ title: "Title", questions: [{ id: "x", type: "text", prompt: "Q" }] }, theme),
		).toBeTruthy();
		expect(tool.renderResult(successResult, {}, theme)).toBeTruthy();
	});
});
