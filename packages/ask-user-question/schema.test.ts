import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { AskUserQuestionParams } from "./schema.ts";

describe("ask-user-question/schema", () => {
	it("질문 배열 JSON 문자열과 느슨한 질문 필드를 허용한다", () => {
		const payload = {
			questions: JSON.stringify([
				{
					question: "오늘 기분이 어떠세요?",
					type: "radio",
					options: ["좋음", "보통", "나쁨"],
				},
			]),
		};

		expect(Value.Check(AskUserQuestionParams, payload)).toBe(true);
	});
});
