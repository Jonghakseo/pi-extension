import type { AskUserQuestionParamsInput, Question, QuestionOption } from "./types.ts";

/**
 * 느슨한 입력을 정규화된 파라미터로 변환한다.
 *
 * 허용하는 변형:
 * - `questions`가 JSON 문자열이면 파싱한다.
 * - 질문의 `question` 필드를 `prompt` 별칭으로 받는다.
 * - `options`가 문자열 배열이면 `{ value, label }` 형태로 승격한다.
 * - `options`가 JSON 문자열이면 파싱한다.
 * - `id`가 없으면 `q1`, `q2` 형태로 자동 생성한다.
 */
export function coerceAskUserQuestionParams(raw: unknown): AskUserQuestionParamsInput {
	if (raw == null || typeof raw !== "object") {
		return { questions: [] };
	}

	const record = raw as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title : undefined;
	const description = typeof record.description === "string" ? record.description : undefined;
	const questions = coerceQuestionList(record.questions);

	return { title, description, questions };
}

function coerceQuestionList(value: unknown): Question[] {
	const list = parseMaybeJsonArray(value);
	if (!list) return [];

	return list
		.map((item, index) => coerceQuestion(item, index))
		.filter((question): question is Question => question != null);
}

function coerceQuestion(value: unknown, index: number): Question | null {
	if (value == null || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;

	const type = coerceType(record.type);
	if (!type) return null;

	const prompt = coerceString(record.prompt) ?? coerceString(record.question);
	if (!prompt) return null;

	const id = coerceString(record.id) ?? `q${index + 1}`;
	const question: Question = { id, type, prompt };

	const label = coerceString(record.label);
	if (label) question.label = label;

	const options = coerceOptions(record.options);
	if (options.length > 0) question.options = options;

	if (typeof record.allowOther === "boolean") question.allowOther = record.allowOther;
	if (typeof record.required === "boolean") question.required = record.required;

	const placeholder = coerceString(record.placeholder);
	if (placeholder) question.placeholder = placeholder;

	const defaultValue = coerceDefault(record.default);
	if (defaultValue !== undefined) question.default = defaultValue;

	return question;
}

function coerceOptions(value: unknown): QuestionOption[] {
	const list = parseMaybeJsonArray(value);
	if (!list) return [];

	return list.map((item) => coerceOption(item)).filter((option): option is QuestionOption => option != null);
}

function coerceOption(value: unknown): QuestionOption | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		return { value: trimmed, label: trimmed };
	}
	if (value == null || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const rawValue = coerceString(record.value) ?? coerceString(record.label);
	const rawLabel = coerceString(record.label) ?? coerceString(record.value);
	if (!rawValue || !rawLabel) return null;
	const option: QuestionOption = { value: rawValue, label: rawLabel };
	const description = coerceString(record.description);
	if (description) option.description = description;
	return option;
}

function coerceType(value: unknown): "radio" | "checkbox" | "text" | null {
	if (value === "radio" || value === "checkbox" || value === "text") return value;
	return null;
}

function coerceString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function coerceDefault(value: unknown): string | string[] | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const strings = value.filter((item): item is string => typeof item === "string");
		return strings.length > 0 ? strings : undefined;
	}
	return undefined;
}

function parseMaybeJsonArray(value: unknown): unknown[] | null {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
