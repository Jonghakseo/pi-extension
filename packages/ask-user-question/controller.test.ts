import { describe, expect, it, vi } from "vitest";

import { createFormController } from "./controller.ts";
import { createAnswerState, normalizeQuestions } from "./state.ts";
import type { EditorAdapter, FormResult, RenderTheme } from "./types.ts";

class FakeEditor implements EditorAdapter {
	text = "";
	onSubmit?: (value: string) => void;
	handledInputs: string[] = [];

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
	}

	handleInput(data: string): void {
		this.handledInputs.push(data);
		if (data.length === 1 && data !== "\t") {
			this.text += data;
		}
	}

	render(): string[] {
		return this.text ? [this.text] : [];
	}
}

const theme: RenderTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => `[${text}]`,
	bold: (text) => text,
};

function createController(questionInput: Parameters<typeof normalizeQuestions>[0]) {
	const questions = normalizeQuestions(questionInput);
	const answerState = createAnswerState(questions);
	const editor = new FakeEditor();
	const requestRender = vi.fn();
	const done = vi.fn<(result: FormResult) => void>();
	const controller = createFormController({
		title: "Title",
		description: "Description",
		questions,
		answerState,
		editor,
		theme,
		requestRender,
		done,
	});
	return { controller, questions, answerState, editor, requestRender, done };
}

describe("ask-user-question/controller", () => {
	it("renders with caching and supports empty question sets", () => {
		const empty = createController([]);
		const firstRender = empty.controller.render(40);
		const secondRender = empty.controller.render(40);
		expect(firstRender).toBe(secondRender);
		empty.controller.invalidate();
		expect(empty.controller.render(40)).not.toBe(firstRender);
		empty.controller.handleInput("x");
		expect(empty.done).not.toHaveBeenCalled();
	});

	it("handles text questions, submission, cancellation, and editor fallback submit", () => {
		const first = createController([{ id: "text", type: "text", prompt: "Explain", default: "seed" }]);
		expect(first.editor.getText()).toBe("seed");

		first.controller.handleInput("!");
		first.controller.handleInput("\r");
		expect(first.done).toHaveBeenCalledWith({
			title: "Title",
			questions: first.questions,
			answers: [{ id: "text", type: "text", value: "seed!", wasCustom: true }],
			cancelled: false,
		});
		expect(first.requestRender).toHaveBeenCalled();

		const cancelled = createController([{ id: "text", type: "text", prompt: "Explain" }]);
		cancelled.controller.handleInput("\u001b");
		expect(cancelled.done).toHaveBeenCalledWith({
			title: "Title",
			questions: cancelled.questions,
			answers: [{ id: "text", type: "text", value: "", wasCustom: true }],
			cancelled: true,
		});

		const fallback = createController([{ id: "text", type: "text", prompt: "Explain" }]);
		fallback.editor.onSubmit?.("  from submit  ");
		expect(fallback.done).toHaveBeenCalledWith({
			title: "Title",
			questions: fallback.questions,
			answers: [{ id: "text", type: "text", value: "from submit", wasCustom: true }],
			cancelled: false,
		});
	});

	it("handles radio other-mode editing, tab navigation, and cancellation", () => {
		const setup = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }] },
			{ id: "text", type: "text", prompt: "Explain" },
		]);
		setup.answerState.radioAnswers.set("radio", { value: "saved", label: "saved", wasCustom: true });

		setup.controller.handleInput("\u001b[B");
		setup.controller.handleInput("\u001b[A");
		setup.controller.handleInput("\u001b[B");
		setup.controller.handleInput("\r");
		expect(setup.controller.getState()).toMatchObject({ otherMode: true, otherQuestionId: "radio" });
		expect(setup.editor.getText()).toBe("saved");
		expect(setup.controller.render(80).join("\n")).toContain("Your answer:");

		setup.controller.handleInput("x");
		setup.controller.handleInput("\t");
		expect(setup.answerState.radioAnswers.get("radio")).toEqual({ value: "savedx", label: "savedx", wasCustom: true });
		expect(setup.controller.getState()).toMatchObject({ currentTab: 1, otherMode: false });

		setup.controller.handleInput("\u001b[Z");
		expect(setup.controller.getState().currentTab).toBe(0);
		setup.controller.handleInput("\u001b");
		expect(setup.done).toHaveBeenCalledWith({
			title: "Title",
			questions: setup.questions,
			answers: [
				{ id: "radio", type: "radio", value: "savedx", wasCustom: true },
				{ id: "text", type: "text", value: "", wasCustom: true },
			],
			cancelled: true,
		});
	});

	it("supports radio selection, checkbox toggles, other-mode enter, and successful submit", () => {
		const setup = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }] },
			{ id: "check", type: "checkbox", prompt: "Pick many", options: [{ value: "b", label: "Beta" }] },
		]);

		setup.controller.handleInput("\r");
		expect(setup.controller.getState().currentTab).toBe(1);
		expect(setup.answerState.radioAnswers.get("radio")).toEqual({ value: "a", label: "Alpha", wasCustom: false });

		setup.controller.handleInput(" ");
		expect(setup.answerState.checkAnswers.get("check")).toEqual(new Set(["b"]));
		setup.controller.handleInput(" ");
		expect(setup.answerState.checkAnswers.get("check")).toEqual(new Set());

		setup.controller.handleInput("\u001b[B");
		setup.controller.handleInput(" ");
		expect(setup.controller.getState().otherMode).toBe(true);
		setup.editor.setText("custom");
		setup.controller.handleInput("\r");
		expect(setup.answerState.checkCustom.get("check")).toBe("custom");
		expect(setup.controller.getState().currentTab).toBe(2);

		setup.controller.handleInput("\r");
		expect(setup.done).toHaveBeenCalledWith({
			title: "Title",
			questions: setup.questions,
			answers: [
				{ id: "radio", type: "radio", value: "a", wasCustom: false },
				{ id: "check", type: "checkbox", value: ["custom"], wasCustom: true },
			],
			cancelled: false,
		});
	});

	it("handles onSubmit custom input, no-option branches, submit-tab navigation, and other-mode escape", () => {
		const submitOther = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }] },
			{ id: "text", type: "text", prompt: "Explain" },
		]);
		submitOther.controller.handleInput("\u001b[B");
		submitOther.controller.handleInput("\r");
		submitOther.editor.onSubmit?.("typed");
		expect(submitOther.answerState.radioAnswers.get("radio")).toEqual({
			value: "typed",
			label: "typed",
			wasCustom: true,
		});
		expect(submitOther.controller.getState().currentTab).toBe(1);

		const nonTextSubmit = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }] },
		]);
		nonTextSubmit.editor.onSubmit?.("ignored");
		expect(nonTextSubmit.done).not.toHaveBeenCalled();

		const shiftOther = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }] },
			{ id: "text", type: "text", prompt: "Explain" },
		]);
		shiftOther.controller.handleInput("\u001b[B");
		shiftOther.controller.handleInput("\r");
		shiftOther.editor.setText("back");
		shiftOther.controller.handleInput("\u001b[Z");
		expect(shiftOther.answerState.radioAnswers.get("radio")).toEqual({ value: "back", label: "back", wasCustom: true });
		expect(shiftOther.controller.getState().currentTab).toBe(2);

		const noOptions = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [], allowOther: false },
			{ id: "check", type: "checkbox", prompt: "Pick many", options: [], allowOther: false },
		]);
		noOptions.controller.handleInput("\r");
		expect(noOptions.done).not.toHaveBeenCalled();
		noOptions.controller.handleInput("\u001b[C");
		noOptions.controller.handleInput("\u001b[D");
		expect(noOptions.controller.getState().currentTab).toBe(0);
		noOptions.controller.handleInput("\u001b[C");
		noOptions.controller.handleInput(" ");
		noOptions.controller.handleInput("\r");
		expect(noOptions.controller.getState().currentTab).toBe(2);

		const deletedSet = createController([
			{ id: "check", type: "checkbox", prompt: "Pick many", options: [{ value: "b", label: "Beta" }] },
		]);
		deletedSet.answerState.checkAnswers.delete("check");
		deletedSet.controller.handleInput(" ");
		expect(deletedSet.answerState.checkAnswers.get("check")).toEqual(new Set(["b"]));
		deletedSet.controller.handleInput("x");
		expect(deletedSet.done).not.toHaveBeenCalled();

		const checkboxSingle = createController([{ id: "check", type: "checkbox", prompt: "Pick many", options: [] }]);
		checkboxSingle.controller.handleInput("\r");
		expect(checkboxSingle.done).toHaveBeenCalledWith({
			title: "Title",
			questions: checkboxSingle.questions,
			answers: [{ id: "check", type: "checkbox", value: [], wasCustom: false }],
			cancelled: false,
		});

		const blocked = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }] },
			{ id: "text", type: "text", prompt: "Explain" },
		]);
		blocked.controller.handleInput("\u001b[C");
		blocked.controller.handleInput("\t");
		expect(blocked.controller.getState().currentTab).toBe(2);
		blocked.controller.handleInput("\r");
		expect(blocked.done).not.toHaveBeenCalled();
		blocked.controller.handleInput("\u001b[D");
		expect(blocked.controller.getState().currentTab).toBe(1);
		blocked.controller.handleInput("\t");
		expect(blocked.controller.getState().currentTab).toBe(2);
		blocked.controller.handleInput("\t");
		expect(blocked.controller.getState().currentTab).toBe(0);
		blocked.controller.handleInput("\u001b");
		expect(blocked.done).toHaveBeenCalled();

		const submitCancel = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }], default: "a" },
			{ id: "text", type: "text", prompt: "Explain", default: "done" },
		]);
		submitCancel.controller.handleInput("\u001b[C");
		submitCancel.controller.handleInput("\t");
		submitCancel.controller.handleInput("\u001b");
		expect(submitCancel.done).toHaveBeenCalled();

		const submitNav = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }], default: "a" },
			{ id: "text", type: "text", prompt: "Explain", default: "done" },
		]);
		submitNav.controller.handleInput("\u001b[C");
		submitNav.controller.handleInput("\t");
		expect(submitNav.controller.getState().currentTab).toBe(2);
		submitNav.controller.handleInput("\u001b[C");
		expect(submitNav.controller.getState().currentTab).toBe(0);

		const otherEscape = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }] },
		]);
		otherEscape.controller.handleInput("\u001b[B");
		otherEscape.controller.handleInput("\r");
		otherEscape.controller.handleInput("\u001b");
		expect(otherEscape.controller.getState()).toMatchObject({ otherMode: false, otherQuestionId: null });
		expect(otherEscape.editor.getText()).toBe("");
	});
});
