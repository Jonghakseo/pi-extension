import { describe, expect, it } from "vitest";

import {
	buildRenderCallText,
	buildRenderResultText,
	errorResult,
	formatResultContent,
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
});
