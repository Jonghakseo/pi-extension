import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme } from "@mariozechner/pi-tui";

import { createFormController } from "./controller.ts";
import { createAnswerState } from "./state.ts";
import type { Answer, FormResult, NormalizedQuestion, RenderTheme } from "./types.ts";

interface AskUserQuestionBridgeRequest {
	title?: string;
	description?: string;
	questions: NormalizedQuestion[];
}

type AskUserQuestionBridge = (
	request: AskUserQuestionBridgeRequest,
	options?: { signal?: AbortSignal },
) => Promise<Record<string, unknown> | undefined>;

interface AskUserQuestionBridgeUI {
	askUserQuestion?: AskUserQuestionBridge;
	ask_user_question?: AskUserQuestionBridge;
}

function getAskUserQuestionBridge(ctx: ExtensionContext): AskUserQuestionBridge | undefined {
	const ui = ctx.ui as ExtensionContext["ui"] & AskUserQuestionBridgeUI;
	if (typeof ui.askUserQuestion === "function") return ui.askUserQuestion.bind(ui);
	if (typeof ui.ask_user_question === "function") return ui.ask_user_question.bind(ui);
	return undefined;
}

function valueAsString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function valueAsStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return typeof value === "string" ? [value] : [];
}

function buildAnswersFromBridgeResult(questions: NormalizedQuestion[], result: Record<string, unknown>): Answer[] {
	return questions.map((question) => {
		const rawValue = result[question.id];
		if (question.type === "radio") {
			const value = valueAsString(rawValue);
			const optionValues = new Set(question.options.map((option) => option.value));
			return {
				id: question.id,
				type: "radio",
				value,
				wasCustom: value.length > 0 && !optionValues.has(value),
			};
		}

		if (question.type === "checkbox") {
			const value = valueAsStringArray(rawValue);
			const optionValues = new Set(question.options.map((option) => option.value));
			return {
				id: question.id,
				type: "checkbox",
				value,
				wasCustom: value.some((item) => !optionValues.has(item)),
			};
		}

		return {
			id: question.id,
			type: "text",
			value: valueAsString(rawValue),
			wasCustom: true,
		};
	});
}

function buildFormResultFromBridgeResult(
	params: { title?: string },
	questions: NormalizedQuestion[],
	result: Record<string, unknown> | undefined,
): FormResult {
	if (!result) {
		return { title: params.title, questions, answers: [], cancelled: true };
	}

	return {
		title: params.title,
		questions,
		answers: buildAnswersFromBridgeResult(questions, result),
		cancelled: false,
	};
}

export function createEditorTheme(theme: Pick<RenderTheme, "fg">): EditorTheme {
	return {
		borderColor: (value) => theme.fg("accent", value),
		selectList: {
			selectedPrefix: (value) => theme.fg("accent", value),
			selectedText: (value) => theme.fg("accent", value),
			description: (value) => theme.fg("muted", value),
			scrollInfo: (value) => theme.fg("dim", value),
			noMatch: (value) => theme.fg("warning", value),
		},
	};
}

export async function runAskUserQuestionForm(
	ctx: ExtensionContext,
	params: { title?: string; description?: string },
	questions: NormalizedQuestion[],
	options: { signal?: AbortSignal } = {},
): Promise<FormResult> {
	const askUserQuestionBridge = getAskUserQuestionBridge(ctx);
	if (askUserQuestionBridge) {
		const request = { title: params.title, description: params.description, questions };
		const result = options.signal
			? await askUserQuestionBridge(request, { signal: options.signal })
			: await askUserQuestionBridge(request);
		return buildFormResultFromBridgeResult(params, questions, result);
	}

	return ctx.ui.custom<FormResult>((tui, theme, _keybindings, done) => {
		return createFormController({
			title: params.title,
			description: params.description,
			questions,
			answerState: createAnswerState(questions),
			editor: new Editor(tui, createEditorTheme(theme)),
			theme,
			requestRender: () => tui.requestRender(),
			done,
		});
	});
}
