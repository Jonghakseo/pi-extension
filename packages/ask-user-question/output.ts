import { Text } from "@earendil-works/pi-tui";

import { SYM } from "./constants.ts";
import type { FormResult, Question, RenderTheme } from "./types.ts";

export function errorResult(message: string): {
	content: { type: "text"; text: string }[];
	details: FormResult;
} {
	return {
		content: [{ type: "text", text: message }],
		details: { questions: [], answers: [], cancelled: true },
	};
}

export function formatResultContent(result: FormResult): string {
	return result.answers
		.map((answer) => {
			const question = result.questions.find((candidate) => candidate.id === answer.id);
			const label = question?.label || answer.id;
			if (answer.type === "radio") {
				const prefix = answer.wasCustom ? "(직접 입력) " : "";
				return `${label}: ${prefix}${answer.value}`;
			}
			if (answer.type === "checkbox") {
				const values = Array.isArray(answer.value) ? answer.value : [answer.value];
				return values.length === 0 ? `${label}: (선택 없음)` : `${label}: ${values.join(", ")}`;
			}
			return `${label}: ${answer.value || "(비어 있음)"}`;
		})
		.join("\n");
}

export function buildRenderCallText(args: { questions?: Question[]; title?: string }, theme: RenderTheme): string {
	const questions = args.questions || [];
	let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
	if (args.title) {
		text += `${theme.fg("accent", args.title)} `;
	}
	text += theme.fg("muted", `${questions.length}개 문항`);
	const types = [...new Set(questions.map((question) => question.type))].join(", ");
	if (types) {
		text += theme.fg("dim", ` (${types})`);
	}
	return text;
}

export function buildRenderResultText(
	result: { content?: Array<{ type: string; text?: string }>; details?: FormResult },
	theme: RenderTheme,
): string {
	const details = result.details;
	if (!details) {
		const text = result.content?.[0];
		return text?.type === "text" ? (text.text ?? "") : "";
	}

	if (details.cancelled) {
		return theme.fg("warning", "취소됨");
	}

	return details.answers
		.map((answer) => {
			const question = details.questions.find((candidate) => candidate.id === answer.id);
			const label = question?.label || answer.id;
			if (answer.type === "radio") {
				const prefix = answer.wasCustom ? theme.fg("dim", "(직접 입력) ") : "";
				return `${theme.fg("success", SYM.check)} ${theme.fg("accent", label)}: ${prefix}${answer.value}`;
			}
			if (answer.type === "checkbox") {
				const values = Array.isArray(answer.value) ? answer.value : [answer.value];
				const display = values.length ? values.join(", ") : theme.fg("dim", "(선택 없음)");
				return `${theme.fg("success", SYM.check)} ${theme.fg("accent", label)}: ${display}`;
			}
			return `${theme.fg("success", SYM.check)} ${theme.fg("accent", label)}: ${answer.value || theme.fg("dim", "(비어 있음)")}`;
		})
		.join("\n");
}

export function renderCall(args: { questions?: Question[]; title?: string }, theme: RenderTheme): Text {
	return new Text(buildRenderCallText(args, theme), 0, 0);
}

export function renderResult(
	result: { content?: Array<{ type: string; text?: string }>; details?: FormResult },
	theme: RenderTheme,
): Text {
	return new Text(buildRenderResultText(result, theme), 0, 0);
}
