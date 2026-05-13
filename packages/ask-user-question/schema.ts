import { Type } from "@sinclair/typebox";

export const OptionSchema = Type.Object({
	value: Type.String({ description: "선택 시 반환할 값" }),
	label: Type.String({ description: "화면에 표시할 라벨" }),
	description: Type.Optional(Type.String({ description: "옵션 아래에 표시할 보조 설명" })),
});

export const LooseOptionSchema = Type.Union([
	OptionSchema,
	Type.String({ description: "문자열 선택지. value/label이 같은 값으로 처리됨" }),
]);

export const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "질문 고유 식별자. 생략 시 q1, q2...로 자동 생성" })),
	type: Type.Union([Type.Literal("radio"), Type.Literal("checkbox"), Type.Literal("text")], {
		description: "질문 유형: radio(단일 선택), checkbox(복수 선택), text(자유 입력)",
	}),
	prompt: Type.Optional(Type.String({ description: "사용자에게 표시할 질문 문구" })),
	question: Type.Optional(Type.String({ description: "prompt 별칭" })),
	label: Type.Optional(Type.String({ description: "탭 바에 표시할 짧은 라벨(기본값: Q1, Q2...)" })),
	options: Type.Optional(
		Type.Union([
			Type.Array(LooseOptionSchema, { description: "radio/checkbox용 선택지 목록" }),
			Type.String({ description: "선택지 배열을 직렬화한 JSON 문자열" }),
		]),
	),
	allowOther: Type.Optional(
		Type.Boolean({ description: "'기타...' 직접 입력 옵션 추가 여부 (radio/checkbox 기본값: true)" }),
	),
	required: Type.Optional(Type.Boolean({ description: "응답 필수 여부 (기본값: true)" })),
	placeholder: Type.Optional(Type.String({ description: "text 입력 시 표시할 플레이스홀더" })),
	default: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "기본값. radio/text는 문자열, checkbox는 문자열 배열",
		}),
	),
});

export const AskUserQuestionParams = Type.Object({
	title: Type.Optional(Type.String({ description: "폼 상단에 표시할 제목" })),
	description: Type.Optional(Type.String({ description: "폼 상단에 표시할 안내 문구" })),
	questions: Type.Union([
		Type.Array(QuestionSchema, {
			description: "질문 목록. radio는 단일 선택, checkbox는 복수 선택, text는 자유 입력",
		}),
		Type.String({ description: "질문 배열을 직렬화한 JSON 문자열" }),
	]),
});
