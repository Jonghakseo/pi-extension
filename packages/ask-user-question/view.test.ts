import { describe, expect, it } from "vitest";

import { createAnswerState, normalizeQuestions } from "./state.ts";
import type { RenderFormInput, RenderTheme } from "./types.ts";
import { renderFooter, renderForm, renderQuestion, renderSubmitTab, renderTabBar } from "./view.ts";

const theme: RenderTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => `[${text}]`,
	bold: (text) => `**${text}**`,
};

function createInput(overrides: Partial<RenderFormInput> = {}): RenderFormInput {
	const questions =
		overrides.questions ??
		normalizeQuestions([
			{
				id: "radio",
				type: "radio",
				prompt: "Pick one",
				options: [
					{ value: "a", label: "Alpha", description: "first" },
					{ value: "b", label: "Beta" },
				],
			},
			{
				id: "text",
				type: "text",
				prompt: "Explain",
				placeholder: "Type here",
			},
		]);
	const answerState = overrides.answerState ?? createAnswerState(questions);
	return {
		title: "Title",
		description: "Description",
		questions,
		answerState,
		currentTab: 0,
		cursorIdx: 0,
		otherMode: false,
		width: 80,
		theme,
		editorLines: ["editor line"],
		editorText: "",
		...overrides,
	};
}

describe("ask-user-question/view", () => {
	it("renders the review tab with missing required answers", () => {
		const input = createInput({ currentTab: 2 });
		const output = renderForm(input).join("\n");

		expect(output).toContain("검토 및 제출");
		expect(output).toContain("Q1:");
		expect(output).toContain("필수 응답: Q1, Q2");
		expect(output).toContain("Tab/←→ 질문 이동 • Enter 제출 • Esc 취소");
	});

	it("renders radio questions including descriptions and other-mode editor", () => {
		const questions = normalizeQuestions([
			{
				id: "radio",
				type: "radio",
				prompt: "Pick one",
				options: [{ value: "a", label: "Alpha", description: "first" }],
			},
		]);
		const answerState = createAnswerState(questions);
		answerState.radioAnswers.set("radio", { value: "custom", label: "custom", wasCustom: true });

		const output = renderForm(
			createInput({
				questions,
				answerState,
				otherMode: true,
				cursorIdx: 1,
				editorLines: ["typed value"],
			}),
		).join("\n");

		expect(output).toContain("**Pick one** [단일 선택]");
		expect(output).toContain("Alpha");
		expect(output).toContain("first");
		expect(output).toContain("기타: custom");
		expect(output).toContain("직접 입력:");
		expect(output).toContain("Enter 제출 • Esc 돌아가기");
	});

	it("renders checkbox and text questions with placeholders and text footer", () => {
		const questions = normalizeQuestions([
			{
				id: "check",
				type: "checkbox",
				prompt: "Pick many",
				options: [{ value: "a", label: "Alpha" }],
			},
			{
				id: "text",
				type: "text",
				prompt: "Explain",
				placeholder: "Type here",
			},
		]);
		const answerState = createAnswerState(questions);
		answerState.checkAnswers.set("check", new Set(["a"]));
		answerState.checkCustom.set("check", "custom option");

		const checkboxOutput = renderForm(createInput({ questions, answerState, editorLines: [], editorText: "" })).join(
			"\n",
		);
		expect(checkboxOutput).toContain("**Pick many** [복수 선택]");
		expect(checkboxOutput).toContain("기타: custom option");
		expect(checkboxOutput).toContain("Space 토글");

		const textOutput = renderForm(
			createInput({ questions, answerState, currentTab: 1, editorLines: ["typed line"], editorText: "" }),
		).join("\n");
		expect(textOutput).toContain("**Explain** [텍스트]");
		expect(textOutput).toContain("Type here");
		expect(textOutput).toContain("typed line");
		expect(textOutput).toContain("Tab/←→ 이동 • Enter 제출 • Esc 취소");
	});

	it("renders answered submit states and optional question variants", () => {
		const questions = normalizeQuestions([
			{
				id: "radio",
				type: "radio",
				prompt: "Pick one",
				options: [{ value: "a", label: "Alpha" }],
				allowOther: false,
			},
			{
				id: "check",
				type: "checkbox",
				prompt: "Pick many",
				options: [{ value: "b", label: "Beta", description: "desc" }],
				allowOther: false,
			},
			{
				id: "text",
				type: "text",
				prompt: "Explain",
				required: false,
			},
		]);
		const answerState = createAnswerState(questions);
		answerState.radioAnswers.set("radio", { value: "a", label: "Alpha", wasCustom: false });
		answerState.checkAnswers.set("check", new Set(["b"]));
		answerState.textAnswers.set("text", "filled");

		const submitOutput = renderForm(createInput({ questions, answerState, currentTab: 3 })).join("\n");
		expect(submitOutput).toContain("Enter로 제출");
		expect(submitOutput).toContain("Alpha");
		expect(submitOutput).toContain("b");
		expect(submitOutput).toContain("filled");

		const radioOutput = renderForm(createInput({ questions, answerState, currentTab: 0, cursorIdx: 0 })).join("\n");
		expect(radioOutput).toContain("❯ ◉ Alpha");
		expect(radioOutput).toContain("Enter 선택 • Esc 취소");
		expect(radioOutput).not.toContain("기타...");

		const checkboxOutput = renderForm(createInput({ questions, answerState, currentTab: 1, cursorIdx: 0 })).join("\n");
		expect(checkboxOutput).toContain("☑ Beta");
		expect(checkboxOutput).toContain("desc");
		expect(checkboxOutput).toContain("Enter 다음");

		const textOutput = renderForm(
			createInput({ questions, answerState, currentTab: 2, editorLines: ["filled"], editorText: "filled" }),
		).join("\n");
		expect(textOutput).toContain("filled");
		expect(textOutput).toContain("Enter 제출 • Esc 취소");
		expect(textOutput).not.toContain("*필수");
	});

	it("covers direct helper branches for invalid tabs and compact variants", () => {
		const lines: string[] = [];
		const add = (text: string) => lines.push(text);
		const singleQuestionInput = createInput({
			questions: normalizeQuestions([
				{ id: "radio", type: "radio", prompt: "Only", options: [{ value: "a", label: "Alpha" }] },
			]),
			currentTab: 99,
		});
		renderTabBar(singleQuestionInput, add);
		renderQuestion(singleQuestionInput, add, 80);
		renderFooter(singleQuestionInput, add);
		expect(lines).toEqual([]);

		const submitQuestions = normalizeQuestions([
			{ id: "radio", type: "radio", prompt: "Only", options: [{ value: "a", label: "Alpha" }] },
			{ id: "check", type: "checkbox", prompt: "Many", options: [{ value: "b", label: "Beta" }] },
		]);
		const submitLines: string[] = [];
		const submitInput = createInput({ questions: submitQuestions, answerState: createAnswerState(submitQuestions) });
		submitInput.answerState.radioAnswers.set("radio", { value: "custom", label: "custom", wasCustom: true });
		submitInput.answerState.checkCustom.set("check", "custom");
		renderSubmitTab(submitInput, (text) => submitLines.push(text));
		expect(submitLines.join("\n")).toContain("(직접 입력) custom");

		const unansweredLines: string[] = [];
		const unansweredInput = createInput({
			questions: submitQuestions,
			answerState: createAnswerState(submitQuestions),
		});
		unansweredInput.answerState.checkAnswers.delete("check");
		renderSubmitTab(unansweredInput, (text) => unansweredLines.push(text));
		expect(unansweredLines.join("\n")).toContain("(미응답)");

		const output = renderForm(createInput({ currentTab: 99 }));
		expect(output.length).toBeGreaterThanOrEqual(2);
	});

	it("covers unchecked and compact render branches", () => {
		const radioQuestions = normalizeQuestions([
			{ id: "radio", type: "radio", prompt: "Only", options: [{ value: "a", label: "Alpha" }], allowOther: true },
		]);
		const radioState = createAnswerState(radioQuestions);
		radioState.radioAnswers.set("radio", { value: "a", label: "Alpha", wasCustom: false });
		const radioLines: string[] = [];
		renderQuestion(
			createInput({
				title: undefined,
				description: undefined,
				questions: radioQuestions,
				answerState: radioState,
				cursorIdx: 0,
				editorLines: [],
			}),
			(text) => radioLines.push(text),
			80,
		);
		expect(radioLines.join("\n")).toContain("❯ ◉ Alpha");
		expect(radioLines.join("\n")).toContain("기타...");
		const radioSelectedLines: string[] = [];
		renderQuestion(
			createInput({
				title: undefined,
				description: undefined,
				questions: radioQuestions,
				answerState: radioState,
				cursorIdx: 1,
				editorLines: [],
			}),
			(text) => radioSelectedLines.push(text),
			80,
		);
		expect(radioSelectedLines.join("\n")).toContain("◉ Alpha");

		const checkboxQuestions = normalizeQuestions([
			{ id: "check", type: "checkbox", prompt: "Only", options: [{ value: "a", label: "Alpha" }], allowOther: true },
		]);
		const checkboxState = createAnswerState(checkboxQuestions);
		checkboxState.checkAnswers.delete("check");
		const checkboxOutput = renderForm(
			createInput({
				title: undefined,
				description: undefined,
				questions: checkboxQuestions,
				answerState: checkboxState,
				editorLines: [],
			}),
		).join("\n");
		expect(checkboxOutput).toContain("☐ Alpha");
		expect(checkboxOutput).toContain("기타...");
		expect(checkboxOutput).toContain("Enter 제출 • Esc 취소");
		checkboxState.checkAnswers.set("check", new Set(["a"]));
		const checkboxOtherCursor = renderForm(
			createInput({
				title: undefined,
				description: undefined,
				questions: checkboxQuestions,
				answerState: checkboxState,
				cursorIdx: 1,
				editorLines: [],
			}),
		).join("\n");
		expect(checkboxOtherCursor).toContain("☑ Alpha");
		expect(checkboxOtherCursor).toContain("❯ ☐ 기타...");
		const checkboxLines: string[] = [];
		renderQuestion(
			createInput({
				title: undefined,
				description: undefined,
				questions: checkboxQuestions,
				answerState: checkboxState,
				cursorIdx: 1,
				editorLines: [],
			}),
			(text) => checkboxLines.push(text),
			80,
		);
		expect(checkboxLines.join("\n")).toContain("☑ Alpha");
		checkboxState.checkAnswers.set("check", new Set());
		const checkboxMutedLines: string[] = [];
		renderQuestion(
			createInput({
				title: undefined,
				description: undefined,
				questions: checkboxQuestions,
				answerState: checkboxState,
				cursorIdx: 1,
				editorLines: [],
			}),
			(text) => checkboxMutedLines.push(text),
			80,
		);
		expect(checkboxMutedLines.join("\n")).toContain("☐ Alpha");

		const textQuestions = normalizeQuestions([{ id: "text", type: "text", prompt: "Only", required: false }]);
		const radioFooterOutput = renderForm(
			createInput({
				title: undefined,
				description: undefined,
				questions: radioQuestions,
				answerState: radioState,
				editorLines: [],
			}),
		).join("\n");
		expect(radioFooterOutput).toContain("Enter 선택 • Esc 취소");
		const textOutput = renderForm(
			createInput({
				title: undefined,
				description: undefined,
				questions: textQuestions,
				answerState: createAnswerState(textQuestions),
				editorLines: [],
				editorText: "",
			}),
		).join("\n");
		expect(textOutput).toContain("**Only** [텍스트]");
		expect(textOutput).toContain("Enter 제출 • Esc 취소");
		expect(textOutput).not.toContain("*필수");
	});
});
