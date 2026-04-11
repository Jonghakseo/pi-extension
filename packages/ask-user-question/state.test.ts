import { describe, expect, it } from "vitest";

import {
	allRequiredAnswered,
	buildAnswers,
	createAnswerState,
	isAnswered,
	normalizeQuestions,
	optionCount,
	saveOtherAnswer,
	saveTextAnswer,
} from "./state.ts";
import type { Question } from "./types.ts";

const baseQuestions: Question[] = [
	{
		id: "radio",
		type: "radio",
		prompt: "Pick one",
		options: [
			{ value: "a", label: "Alpha" },
			{ value: "b", label: "Beta" },
		],
		default: "b",
	},
	{
		id: "check",
		type: "checkbox",
		prompt: "Pick many",
		options: [{ value: "a", label: "Alpha" }],
		default: ["a", "a"],
	},
	{
		id: "text",
		type: "text",
		prompt: "Tell me",
		default: " hello ",
		required: false,
	},
	{
		id: "optional-radio",
		type: "radio",
		prompt: "Optional",
		options: [{ value: "x", label: "X" }],
		required: false,
		allowOther: false,
	},
];

describe("ask-user-question/state", () => {
	it("normalizes questions and applies defaults", () => {
		const questions = normalizeQuestions(baseQuestions);
		const answerState = createAnswerState(questions);

		expect(questions[0]).toMatchObject({ label: "Q1", allowOther: true, required: true });
		expect(questions[2]).toMatchObject({ allowOther: false, required: false });
		expect(questions[3]).toMatchObject({ label: "Q4", allowOther: false, required: false });
		expect(answerState.radioAnswers.get("radio")).toEqual({ value: "b", label: "Beta", wasCustom: false });
		expect(answerState.checkAnswers.get("check")).toEqual(new Set(["a"]));
		expect(answerState.textAnswers.get("text")).toBe(" hello ");
	});

	it("ignores unmatched radio defaults and calculates option counts", () => {
		const questions = normalizeQuestions([
			{
				id: "x",
				type: "radio",
				prompt: "Q",
				options: [{ value: "a", label: "A" }],
				default: "missing",
				allowOther: false,
			},
			{ id: "y", type: "text", prompt: "Text" },
		]);
		const answerState = createAnswerState(questions);

		expect(answerState.radioAnswers.has("x")).toBe(false);
		expect(optionCount(questions[0])).toBe(1);
		expect(optionCount(questions[1])).toBe(0);
	});

	it("tracks answered state and required completion", () => {
		const questions = normalizeQuestions(baseQuestions);
		const answerState = createAnswerState(questions);

		expect(isAnswered(answerState, questions[0])).toBe(true);
		expect(isAnswered(answerState, questions[1])).toBe(true);
		expect(isAnswered(answerState, questions[2])).toBe(true);
		expect(isAnswered(answerState, questions[3])).toBe(false);
		expect(allRequiredAnswered(answerState, questions)).toBe(true);

		saveTextAnswer(answerState, "text", "   ");
		expect(isAnswered(answerState, questions[2])).toBe(false);
		expect(allRequiredAnswered(answerState, questions)).toBe(true);
	});

	it("saves text answers and custom answers only when valid", () => {
		const questions = normalizeQuestions(baseQuestions);
		const answerState = createAnswerState(questions);

		saveTextAnswer(answerState, "text", "  updated  ");
		saveOtherAnswer(answerState, questions, "radio", "  custom radio  ");
		saveOtherAnswer(answerState, questions, "check", "  custom check  ");
		saveOtherAnswer(answerState, questions, "missing", "ignored");
		saveOtherAnswer(answerState, questions, "text", "ignored");
		saveOtherAnswer(answerState, questions, "check", "   ");

		expect(answerState.textAnswers.get("text")).toBe("updated");
		expect(answerState.radioAnswers.get("radio")).toEqual({
			value: "custom radio",
			label: "custom radio",
			wasCustom: true,
		});
		expect(answerState.checkCustom.get("check")).toBe("custom check");
	});

	it("builds result answers for all question types", () => {
		const questions = normalizeQuestions(baseQuestions);
		const answerState = createAnswerState(questions);
		saveOtherAnswer(answerState, questions, "radio", "custom radio");
		saveOtherAnswer(answerState, questions, "check", "custom check");
		saveTextAnswer(answerState, "text", "updated");

		expect(buildAnswers(answerState, questions)).toEqual([
			{ id: "radio", type: "radio", value: "custom radio", wasCustom: true },
			{ id: "check", type: "checkbox", value: ["a", "custom check"], wasCustom: true },
			{ id: "text", type: "text", value: "updated", wasCustom: true },
			{ id: "optional-radio", type: "radio", value: "", wasCustom: false },
		]);
		const defaultState = createAnswerState(questions);
		defaultState.checkAnswers.delete("check");
		const defaultAnswers = buildAnswers(defaultState, questions);
		expect(defaultAnswers[1]).toEqual({ id: "check", type: "checkbox", value: [], wasCustom: false });
		expect(defaultAnswers[3]).toEqual({ id: "optional-radio", type: "radio", value: "", wasCustom: false });
	});
});
