import { describe, expect, it } from "vitest";

import { coerceAskUserQuestionParams } from "./coerce.ts";

describe("coerceAskUserQuestionParams", () => {
	it("구조화된 파라미터를 그대로 보존한다", () => {
		const input = {
			title: "Title",
			description: "Desc",
			questions: [
				{
					id: "env",
					type: "radio",
					prompt: "어느 환경?",
					options: [
						{ value: "staging", label: "스테이징" },
						{ value: "prod", label: "프로덕션", description: "실서비스" },
					],
					allowOther: false,
					required: true,
					default: "staging",
				},
			],
		};

		const result = coerceAskUserQuestionParams(input);
		expect(result).toEqual(input);
	});

	it("JSON 문자열로 전달된 questions를 파싱한다", () => {
		const payload = {
			questions: JSON.stringify([
				{
					type: "radio",
					question: "파일 배치 구조",
					options: ["directory", "single file", "single file + flat"],
					allowOther: true,
				},
				{
					type: "checkbox",
					question: "포함 여부",
					options: ["LICENSE", "author attribution"],
				},
				{
					type: "text",
					question: "추가 메모",
					placeholder: "선택 사항",
					required: false,
				},
			]),
		};

		const result = coerceAskUserQuestionParams(payload);

		expect(result.questions).toHaveLength(3);
		expect(result.questions[0]).toEqual({
			id: "q1",
			type: "radio",
			prompt: "파일 배치 구조",
			options: [
				{ value: "directory", label: "directory" },
				{ value: "single file", label: "single file" },
				{ value: "single file + flat", label: "single file + flat" },
			],
			allowOther: true,
		});
		expect(result.questions[1].id).toBe("q2");
		expect(result.questions[1].type).toBe("checkbox");
		expect(result.questions[1].options).toEqual([
			{ value: "LICENSE", label: "LICENSE" },
			{ value: "author attribution", label: "author attribution" },
		]);
		expect(result.questions[2]).toEqual({
			id: "q3",
			type: "text",
			prompt: "추가 메모",
			placeholder: "선택 사항",
			required: false,
		});
	});

	it("question 별칭과 options JSON 문자열을 지원한다", () => {
		const result = coerceAskUserQuestionParams({
			questions: [
				{
					type: "radio",
					question: "extension 이름",
					options: JSON.stringify(["claude-code-use", "pi-claude-code-use"]),
				},
			],
		});

		expect(result.questions[0].prompt).toBe("extension 이름");
		expect(result.questions[0].options).toEqual([
			{ value: "claude-code-use", label: "claude-code-use" },
			{ value: "pi-claude-code-use", label: "pi-claude-code-use" },
		]);
	});

	it("잘못된 입력을 조용히 걸러낸다", () => {
		const result = coerceAskUserQuestionParams({
			questions: [
				null,
				{ type: "radio" }, // prompt 없음 -> 제외
				{ type: "unknown", prompt: "?" }, // 잘못된 type -> 제외
				{ type: "text", prompt: "OK" },
				"not-an-object",
			],
		});

		expect(result.questions).toHaveLength(1);
		expect(result.questions[0]).toMatchObject({ id: "q4", type: "text", prompt: "OK" });
	});

	it("questions 자체가 누락되거나 비-객체 입력이면 빈 배열을 돌려준다", () => {
		expect(coerceAskUserQuestionParams(null).questions).toEqual([]);
		expect(coerceAskUserQuestionParams(undefined).questions).toEqual([]);
		expect(coerceAskUserQuestionParams({ questions: "not-json" }).questions).toEqual([]);
		expect(coerceAskUserQuestionParams({ questions: '{"not":"array"}' }).questions).toEqual([]);
	});

	it("checkbox default가 배열이면 문자열만 남겨 보존한다", () => {
		const result = coerceAskUserQuestionParams({
			questions: [
				{
					type: "checkbox",
					prompt: "포함할 항목",
					options: ["a", "b", "c"],
					default: ["a", 42, "b", null],
				},
			],
		});
		expect(result.questions[0].default).toEqual(["a", "b"]);
	});

	it("default 배열에서 유효 문자열이 없으면 기본값을 비워 둔다", () => {
		const result = coerceAskUserQuestionParams({
			questions: [
				{
					type: "checkbox",
					prompt: "포함할 항목",
					options: ["a", "b"],
					default: [1, 2, null],
				},
			],
		});
		expect(result.questions[0].default).toBeUndefined();
	});

	it("질문 수준의 label, empty/non-string 옵션, JSON 되는 빈 문자열 등 세부 변형을 사장 없이 무시한다", () => {
		const result = coerceAskUserQuestionParams({
			questions: [
				{
					id: "labelled",
					type: "radio",
					prompt: "완전한 질문",
					label: "Short label",
					options: [
						"   ", // empty string option -> dropped
						42, // non-string, non-object option -> dropped
						{ label: "Label only" }, // label -> promoted to value
						{ value: "raw-value" }, // value -> promoted to label
						{ description: "no label/value" }, // dropped
						{ value: "v", label: "L", description: "with description" },
					],
				},
			],
		});

		expect(result.questions[0].label).toBe("Short label");
		expect(result.questions[0].options).toEqual([
			{ value: "Label only", label: "Label only" },
			{ value: "raw-value", label: "raw-value" },
			{ value: "v", label: "L", description: "with description" },
		]);
	});

	it("빈 문자열 questions 필드는 빈 배열로 간주한다", () => {
		expect(coerceAskUserQuestionParams({ questions: "   " }).questions).toEqual([]);
	});

	it("공백만 있는 prompt/label 문자열은 없는 것으로 간주한다", () => {
		const result = coerceAskUserQuestionParams({
			questions: [
				{ type: "radio", prompt: "   " }, // whitespace prompt -> dropped
				{ type: "text", prompt: "valid", label: "   " }, // whitespace label -> ignored
			],
		});
		expect(result.questions).toHaveLength(1);
		expect(result.questions[0]).toMatchObject({ type: "text", prompt: "valid" });
		expect(result.questions[0].label).toBeUndefined();
	});
});
