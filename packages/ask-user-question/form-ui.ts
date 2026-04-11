import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme } from "@mariozechner/pi-tui";

import { createFormController } from "./controller.ts";
import { createAnswerState } from "./state.ts";
import type { FormResult, NormalizedQuestion, RenderTheme } from "./types.ts";

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
): Promise<FormResult> {
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
