import { describe, expect, it } from "vitest";

import {
	buildRenderCallText,
	buildRenderResultText,
	errorResult,
	formatResultContent,
	nonInteractiveResult,
	renderCall,
	renderResult,
} from "./output.ts";
import type { FormResult, RenderTheme } from "./types.ts";

const theme: RenderTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => `[${text}]`,
	bold: (text) => `**${text}**`,
};

const formResult: FormResult = {
	title: "Form",
	cancelled: false,
	questions: [
		{ id: "q1", type: "radio", prompt: "Q1", label: "One", options: [], allowOther: true, required: true },
		{ id: "q2", type: "checkbox", prompt: "Q2", label: "Two", options: [], allowOther: true, required: true },
		{ id: "q3", type: "text", prompt: "Q3", label: "Three", options: [], allowOther: false, required: true },
	],
	answers: [
		{ id: "q1", type: "radio", value: "custom", wasCustom: true },
		{ id: "q2", type: "checkbox", value: [], wasCustom: false },
		{ id: "q3", type: "text", value: "", wasCustom: true },
	],
};

describe("ask-user-question/output", () => {
	it("builds error results", () => {
		expect(errorResult("boom")).toEqual({
			content: [{ type: "text", text: "boom" }],
			details: { questions: [], answers: [], cancelled: true },
		});
	});

	it("formats successful result content", () => {
		expect(formatResultContent(formResult)).toBe("One: (직접 입력) custom\nTwo: (선택 없음)\nThree: (비어 있음)");
		expect(
			formatResultContent({
				...formResult,
				answers: [
					{ id: "missing", type: "radio", value: "picked", wasCustom: false },
					{ id: "q2", type: "checkbox", value: ["a", "b"], wasCustom: false },
					{ id: "q3", type: "text", value: "filled", wasCustom: true },
				],
			}),
		).toBe("missing: picked\nTwo: a, b\nThree: filled");
		expect(
			formatResultContent({
				...formResult,
				answers: [{ id: "q2", type: "checkbox", value: "solo", wasCustom: false }],
			}),
		).toBe("Two: solo");
	});

	it("builds render-call summaries", () => {
		expect(
			buildRenderCallText({ title: "Title", questions: [{ id: "x", type: "radio", prompt: "Q" }] }, theme),
		).toContain("Title 1개 문항 (radio)");
		expect(buildRenderCallText({}, theme)).toContain("0개 문항");
		expect(renderCall({ title: "Title", questions: [] }, theme)).toBeTruthy();
	});

	it("builds render-result text across branches", () => {
		expect(buildRenderResultText({ content: [{ type: "text", text: "plain" }] }, theme)).toBe("plain");
		expect(buildRenderResultText({ content: [{ type: "text" }] }, theme)).toBe("");
		expect(buildRenderResultText({ content: [{ type: "image", text: "ignored" }] }, theme)).toBe("");
		expect(buildRenderResultText({}, theme)).toBe("");
		expect(buildRenderResultText({ details: { ...formResult, cancelled: true } }, theme)).toBe("취소됨");
		expect(buildRenderResultText({ details: formResult }, theme)).toBe(
			"✓ One: (직접 입력) custom\n✓ Two: (선택 없음)\n✓ Three: (비어 있음)",
		);
		expect(
			buildRenderResultText(
				{
					details: {
						...formResult,
						answers: [
							{ id: "missing", type: "radio", value: "picked", wasCustom: false },
							{ id: "q2", type: "checkbox", value: ["a"], wasCustom: false },
							{ id: "q3", type: "text", value: "filled", wasCustom: true },
						],
					},
				},
				theme,
			),
		).toBe("✓ missing: picked\n✓ Two: a\n✓ Three: filled");
		expect(
			buildRenderResultText(
				{ details: { ...formResult, answers: [{ id: "q2", type: "checkbox", value: "solo", wasCustom: false }] } },
				theme,
			),
		).toBe("✓ Two: solo");
		expect(renderResult({ details: formResult }, theme)).toBeTruthy();
	});

	it("nonInteractiveResult는 질문 목록을 텍스트로 포함한다", () => {
		const result = nonInteractiveResult("배포 확인", [
			{
				id: "env",
				type: "radio",
				prompt: "어느 환경?",
				label: "Q1",
				options: [{ value: "prod", label: "프로덕션", description: "운영" }],
				allowOther: true,
				required: true,
			},
			{
				id: "targets",
				type: "checkbox",
				prompt: "반영 항목?",
				label: "Q2",
				options: [{ value: "web", label: "웹" }],
				allowOther: false,
				required: true,
			},
			{
				id: "note",
				type: "text",
				prompt: "메모",
				label: "Q3",
				options: [],
				allowOther: false,
				required: false,
				placeholder: "선택 사항",
			},
		]);

		const text = result.content[0].text;
		expect(text).toContain("사용자 입력 필요");
		expect(text).toContain("제목: 배포 확인");
		expect(text).toContain("1. Q1: 어느 환경? [단일 선택]");
		expect(text).toContain("- 프로덕션 [prod] — 운영");
		expect(text).toContain("기타 (직접 입력)");
		expect(text).toContain("2. Q2: 반영 항목? [복수 선택]");
		expect(text).toContain("3. Q3: 메모 [자유 입력]");
		expect(text).toContain("(선택 사항)");
		expect(result.details).toMatchObject({ title: "배포 확인", cancelled: true, answers: [] });
		expect(result.details.questions).toHaveLength(3);

		const untitled = nonInteractiveResult(undefined, []);
		expect(untitled.content[0].text).not.toContain("제목:");
		expect(untitled.details.title).toBeUndefined();
	});
});
