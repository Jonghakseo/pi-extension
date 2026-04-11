import { Key, matchesKey } from "@mariozechner/pi-tui";

import { allRequiredAnswered, buildAnswers, optionCount, saveOtherAnswer, saveTextAnswer } from "./state.ts";
import type { AnswerState, EditorAdapter, FormResult, NormalizedQuestion, RenderTheme } from "./types.ts";
import { renderForm } from "./view.ts";

export interface FormController {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	getState(): {
		currentTab: number;
		cursorIdx: number;
		otherMode: boolean;
		otherQuestionId: string | null;
	};
}

interface CreateFormControllerInput {
	title?: string;
	description?: string;
	questions: NormalizedQuestion[];
	answerState: AnswerState;
	editor: EditorAdapter;
	theme: RenderTheme;
	requestRender(): void;
	done(result: FormResult): void;
}

export function createFormController(input: CreateFormControllerInput): FormController {
	const { questions, answerState, editor, theme } = input;
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + (isMulti ? 1 : 0);

	let currentTab = 0;
	let cursorIdx = 0;
	let otherMode = false;
	let otherQuestionId: string | null = null;
	let cachedLines: string[] | undefined;

	function getCurrentQuestion(): NormalizedQuestion | undefined {
		return questions[currentTab];
	}

	function refresh(): void {
		cachedLines = undefined;
		input.requestRender();
	}

	function saveCurrentTextQuestion(): void {
		const question = getCurrentQuestion();
		if (question?.type !== "text") return;
		saveTextAnswer(answerState, question.id, editor.getText());
	}

	function saveOtherModeText(questionId: string): void {
		saveOtherAnswer(answerState, questions, questionId, editor.getText());
		otherMode = false;
		otherQuestionId = null;
		editor.setText("");
	}

	function switchTab(nextTab: number): void {
		saveCurrentTextQuestion();
		currentTab = ((nextTab % totalTabs) + totalTabs) % totalTabs;
		cursorIdx = 0;
		otherMode = false;
		otherQuestionId = null;
		const question = getCurrentQuestion();
		if (question?.type === "text") {
			editor.setText(answerState.textAnswers.get(question.id) ?? "");
		}
		refresh();
	}

	function finish(cancelled: boolean): void {
		saveCurrentTextQuestion();
		input.done({
			title: input.title,
			questions,
			answers: buildAnswers(answerState, questions),
			cancelled,
		});
	}

	function advanceTab(): void {
		if (!isMulti) {
			finish(false);
			return;
		}
		switchTab(currentTab < questions.length - 1 ? currentTab + 1 : questions.length);
	}

	editor.onSubmit = (value) => {
		const trimmed = value.trim();
		if (otherMode && otherQuestionId) {
			saveOtherAnswer(answerState, questions, otherQuestionId, trimmed);
			otherMode = false;
			otherQuestionId = null;
			editor.setText("");
			advanceTab();
			return;
		}

		const question = getCurrentQuestion();
		if (question?.type === "text") {
			saveTextAnswer(answerState, question.id, trimmed);
			editor.setText(trimmed);
			advanceTab();
		}
	};

	if (questions[0]?.type === "text") {
		editor.setText(answerState.textAnswers.get(questions[0].id) ?? "");
	}

	return {
		render(width) {
			if (cachedLines) return cachedLines;
			cachedLines = renderForm({
				title: input.title,
				description: input.description,
				questions,
				answerState,
				currentTab,
				cursorIdx,
				otherMode,
				width,
				theme,
				editorLines: editor.render(Math.min(width, 120) - (otherMode ? 6 : 4)),
				editorText: editor.getText(),
			});
			return cachedLines;
		},
		invalidate() {
			cachedLines = undefined;
		},
		handleInput(data) {
			if (otherMode) {
				if (matchesKey(data, Key.escape)) {
					otherMode = false;
					otherQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter) && otherQuestionId) {
					saveOtherModeText(otherQuestionId);
					advanceTab();
					return;
				}
				if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) && otherQuestionId) {
					saveOtherModeText(otherQuestionId);
					switchTab(currentTab + (matchesKey(data, Key.shift("tab")) ? -1 : 1));
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const question = getCurrentQuestion();
			if (question?.type === "text") {
				if (matchesKey(data, Key.enter)) {
					saveCurrentTextQuestion();
					advanceTab();
					return;
				}
				if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
					saveCurrentTextQuestion();
					switchTab(currentTab + (matchesKey(data, Key.shift("tab")) ? -1 : 1));
					return;
				}
				if (matchesKey(data, Key.escape)) {
					finish(true);
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (isMulti && currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allRequiredAnswered(answerState, questions)) {
					finish(false);
					return;
				}
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					switchTab(0);
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					switchTab(currentTab - 1);
					return;
				}
				if (matchesKey(data, Key.escape)) {
					finish(true);
					return;
				}
				return;
			}

			if (!question) return;

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					switchTab(currentTab + 1);
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					switchTab(currentTab - 1);
					return;
				}
			}

			const totalOptions = optionCount(question);
			if (matchesKey(data, Key.up)) {
				cursorIdx = Math.max(0, cursorIdx - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursorIdx = Math.min(totalOptions - 1, cursorIdx + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				finish(true);
				return;
			}

			if (question.type === "radio" && matchesKey(data, Key.enter)) {
				const isOther = question.allowOther && cursorIdx === question.options.length;
				if (isOther) {
					otherMode = true;
					otherQuestionId = question.id;
					const existing = answerState.radioAnswers.get(question.id);
					editor.setText(existing?.wasCustom ? existing.label : "");
					refresh();
					return;
				}

				const option = question.options[cursorIdx];
				if (option) {
					answerState.radioAnswers.set(question.id, { value: option.value, label: option.label, wasCustom: false });
					advanceTab();
				}
				return;
			}

			if (question.type === "checkbox" && matchesKey(data, Key.space)) {
				const isOther = question.allowOther && cursorIdx === question.options.length;
				if (isOther) {
					otherMode = true;
					otherQuestionId = question.id;
					editor.setText(answerState.checkCustom.get(question.id) ?? "");
					refresh();
					return;
				}

				const option = question.options[cursorIdx];
				if (option) {
					const selected = answerState.checkAnswers.get(question.id) ?? new Set<string>();
					if (selected.has(option.value)) selected.delete(option.value);
					else selected.add(option.value);
					answerState.checkAnswers.set(question.id, selected);
					refresh();
				}
				return;
			}

			if (question.type === "checkbox" && matchesKey(data, Key.enter)) {
				advanceTab();
			}
		},
		getState() {
			return { currentTab, cursorIdx, otherMode, otherQuestionId };
		},
	};
}
