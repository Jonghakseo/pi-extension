import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

	it("UI가 없으면 질문 목록을 담은 비대화형 fallback 응답을 반환한다", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("ask_user_question");
		if (!tool.execute) throw new Error("execute is missing");

		const noUi = await tool.execute(
			"call-1",
			{
				title: "Title",
				questions: [
					{ id: "env", type: "radio", prompt: "환경?", options: [{ value: "prod", label: "프로덕션" }] },
					{ id: "note", type: "text", prompt: "메모", placeholder: "선택 사항" },
				],
			},
			undefined,
			undefined,
			{ hasUI: false } as unknown as ExtensionContext,
		);

		const text = (noUi as { content: { text: string }[] }).content[0].text;
		expect(text).toContain("사용자 입력 필요");
		expect(text).toContain("1. Q1: 환경? [단일 선택]");
		expect(text).toContain("- 프로덕션 [prod]");
		expect(text).toContain("기타 (직접 입력)");
		expect(text).toContain("2. Q2: 메모 [자유 입력]");
		expect(noUi).toMatchObject({ details: { cancelled: true, answers: [] } });
		expect((noUi as { details: { questions: unknown[] } }).details.questions).toHaveLength(2);
	});

	it("returns errors when no questions are provided", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("ask_user_question");
		if (!tool.execute) throw new Error("execute is missing");

		const noQuestions = await tool.execute("call-2", { title: "Title", questions: [] }, undefined, undefined, {
			hasUI: true,
			ui: { custom: vi.fn() },
		} as unknown as ExtensionContext);
		const invalidQuestions = await tool.execute(
			"call-2b",
			{ title: "Title", questions: "not-json" },
			undefined,
			undefined,
			{ hasUI: true, ui: { custom: vi.fn() } } as unknown as ExtensionContext,
		);

		expect(noQuestions).toMatchObject({ content: [{ type: "text", text: "오류: 질문이 제공되지 않았습니다." }] });
		expect(invalidQuestions).toMatchObject({ content: [{ type: "text", text: "오류: 질문이 제공되지 않았습니다." }] });
	});

	it("JSON 문자열로 직렬화된 questions도 폼 실행 경로로 진입한다", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("ask_user_question");
		if (!tool.execute) throw new Error("execute is missing");

		const customMock = vi.fn(async () => ({
			title: undefined,
			questions: normalizeQuestions([
				{
					id: "q1",
					type: "radio",
					prompt: "extension 이름",
					options: [
						{ value: "claude-code-use", label: "claude-code-use" },
						{ value: "pi-claude-code-use", label: "pi-claude-code-use" },
					],
				},
			]),
			answers: [{ id: "q1", type: "radio" as const, value: "claude-code-use", wasCustom: false }],
			cancelled: false,
		}));

		const serializedResult = await tool.execute(
			"call-json",
			{
				questions: JSON.stringify([
					{
						type: "radio",
						question: "extension 이름",
						options: ["claude-code-use", "pi-claude-code-use"],
						allowOther: true,
					},
				]),
			},
			undefined,
			undefined,
			{ hasUI: true, ui: { custom: customMock } } as unknown as ExtensionContext,
		);

		expect(customMock).toHaveBeenCalledTimes(1);
		expect(serializedResult).toMatchObject({
			content: [{ type: "text", text: "Q1: claude-code-use" }],
		});
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
