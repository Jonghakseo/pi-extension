import type { Answer, AnswerState, NormalizedQuestion, Question } from "./types.ts";

export function normalizeQuestions(questions: Question[]): NormalizedQuestion[] {
	return questions.map((question, index) => ({
		...question,
		label: question.label || `Q${index + 1}`,
		options: question.options || [],
		allowOther: question.type === "text" ? false : question.allowOther !== false,
		required: question.required !== false,
	}));
}

export function createAnswerState(questions: NormalizedQuestion[]): AnswerState {
	const answerState: AnswerState = {
		radioAnswers: new Map(),
		checkAnswers: new Map(),
		checkCustom: new Map(),
		textAnswers: new Map(),
	};

	for (const question of questions) {
		if (question.type === "checkbox") {
			const defaults = new Set<string>();
			if (Array.isArray(question.default)) {
				for (const value of question.default) defaults.add(value);
			}
			answerState.checkAnswers.set(question.id, defaults);
			continue;
		}

		if (question.type === "text" && typeof question.default === "string") {
			answerState.textAnswers.set(question.id, question.default);
			continue;
		}

		if (question.type === "radio" && typeof question.default === "string") {
			const option = question.options.find((candidate) => candidate.value === question.default);
			if (option) {
				answerState.radioAnswers.set(question.id, {
					value: option.value,
					label: option.label,
					wasCustom: false,
				});
			}
		}
	}

	return answerState;
}

export function optionCount(question: NormalizedQuestion): number {
	if (question.type === "text") return 0;
	return question.options.length + (question.allowOther ? 1 : 0);
}

export function saveTextAnswer(answerState: AnswerState, questionId: string, text: string): void {
	const trimmed = text.trim();
	if (trimmed) {
		answerState.textAnswers.set(questionId, trimmed);
		return;
	}
	answerState.textAnswers.delete(questionId);
}

export function saveOtherAnswer(
	answerState: AnswerState,
	questions: NormalizedQuestion[],
	questionId: string,
	text: string,
): void {
	const question = questions.find((candidate) => candidate.id === questionId);
	const trimmed = text.trim();
	if (!question || !trimmed) return;

	if (question.type === "radio") {
		answerState.radioAnswers.set(question.id, { value: trimmed, label: trimmed, wasCustom: true });
		return;
	}

	if (question.type === "checkbox") {
		answerState.checkCustom.set(question.id, trimmed);
	}
}

export function isAnswered(answerState: AnswerState, question: NormalizedQuestion): boolean {
	if (question.type === "radio") return answerState.radioAnswers.has(question.id);
	if (question.type === "checkbox") {
		const selected = answerState.checkAnswers.get(question.id);
		const custom = answerState.checkCustom.get(question.id);
		return (selected != null && selected.size > 0) || (custom != null && custom.trim().length > 0);
	}
	return (answerState.textAnswers.get(question.id)?.trim() ?? "").length > 0;
}

export function allRequiredAnswered(answerState: AnswerState, questions: NormalizedQuestion[]): boolean {
	return questions.every((question) => !question.required || isAnswered(answerState, question));
}

export function buildAnswers(answerState: AnswerState, questions: NormalizedQuestion[]): Answer[] {
	return questions.map((question) => {
		if (question.type === "radio") {
			const answer = answerState.radioAnswers.get(question.id);
			return {
				id: question.id,
				type: "radio",
				value: answer?.value ?? "",
				wasCustom: answer?.wasCustom ?? false,
			};
		}

		if (question.type === "checkbox") {
			const selected = answerState.checkAnswers.get(question.id) ?? new Set<string>();
			const custom = answerState.checkCustom.get(question.id)?.trim();
			const values = [...selected];
			if (custom) values.push(custom);
			return {
				id: question.id,
				type: "checkbox",
				value: values,
				wasCustom: Boolean(custom),
			};
		}

		return {
			id: question.id,
			type: "text",
			value: answerState.textAnswers.get(question.id) ?? "",
			wasCustom: true,
		};
	});
}
