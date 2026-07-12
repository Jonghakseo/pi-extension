import { describe, expect, it, vi } from "vitest";

import { createFormController } from "./controller.ts";
import { createAnswerState, normalizeQuestions } from "./state.ts";
import type { EditorAdapter, FormResult, RenderTheme } from "./types.ts";

class FakeEditor implements EditorAdapter {
	text = "";
	onSubmit?: (value: string) => void;
	isShowingAutocomplete?: () => boolean;
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

	it("invalidates cached lines when render width changes (terminal resize)", () => {
		const setup = createController([{ id: "text", type: "text", prompt: "Explain" }]);
		const wide = setup.controller.render(70);
		const narrow = setup.controller.render(34);
		expect(narrow).not.toBe(wide);
		for (const line of narrow) {
			expect(line.length).toBeLessThanOrEqual(34);
		}
		const narrowAgain = setup.controller.render(34);
		expect(narrowAgain).toBe(narrow);
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
		expect(setup.controller.render(80).join("\n")).toContain("직접 입력:");

		setup.controller.handleInput("x");
		setup.controller.handleInput("\t");
		expect(setup.answerState.radioAnswers.get("radio")).toEqual({ value: "savedx", label: "savedx", wasCustom: true });
		expect(setup.controller.getState()).toMatchObject({ currentTab: 1, otherMode: false });

		setup.controller.handleInput("\u001b[Z");
		expect(setup.controller.getState().currentTab).toBe(0);
		setup.controller.handleInput("\u001b");
		expect(setup.done).not.toHaveBeenCalled();
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

	it("입력이 없으면 Esc 한 번에 바로 취소한다", () => {
		const clean = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }] },
		]);
		clean.controller.handleInput("\u001b");
		expect(clean.done).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
	});

	it("응답이 있으면 Esc 두 번을 눌러야 취소된다", () => {
		const guarded = createController([
			{
				id: "check",
				type: "checkbox",
				prompt: "Pick many",
				options: [{ value: "a", label: "Alpha" }],
			},
		]);
		guarded.controller.handleInput(" ");
		guarded.controller.handleInput("\u001b");
		expect(guarded.done).not.toHaveBeenCalled();
		expect(guarded.controller.getState().dismissPending).toBe(true);
		expect(guarded.controller.render(80).join("\n")).toContain("저장되지 않은 응답이 있습니다");
		guarded.controller.handleInput("\u001b");
		expect(guarded.done).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
	});

	it("Esc 확인 대기 중 다른 키를 누르면 취소 확인이 해제된다", () => {
		const guarded = createController([
			{
				id: "check",
				type: "checkbox",
				prompt: "Pick many",
				options: [
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
				],
			},
		]);
		guarded.controller.handleInput(" ");
		guarded.controller.handleInput("\u001b");
		expect(guarded.controller.getState().dismissPending).toBe(true);
		guarded.controller.handleInput("\u001b[B");
		expect(guarded.controller.getState().dismissPending).toBe(false);
		expect(guarded.done).not.toHaveBeenCalled();
		guarded.controller.handleInput("\u001b");
		expect(guarded.controller.getState().dismissPending).toBe(true);
	});

	it("텍스트 입력 후 Esc는 dismiss guard를 거친다", () => {
		const typed = createController([{ id: "text", type: "text", prompt: "Explain" }]);
		typed.controller.handleInput("h");
		typed.controller.handleInput("\u001b");
		expect(typed.done).not.toHaveBeenCalled();
		typed.controller.handleInput("\u001b");
		expect(typed.done).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
	});

	it("커서 이동만으로는 dirty가 되지 않는다", () => {
		const moved = createController([{ id: "text", type: "text", prompt: "Explain" }]);
		moved.controller.handleInput("\u001b[A");
		moved.controller.handleInput("\u001b");
		expect(moved.done).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
	});

	it("공백만 제출된 onSubmit은 dirty를 설정하지 않는다", () => {
		const blank = createController([{ id: "text", type: "text", prompt: "Explain", required: false }]);
		blank.editor.onSubmit?.("   ");
		expect(blank.done).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelled: false,
				answers: [{ id: "text", type: "text", value: "", wasCustom: true }],
			}),
		);
	});

	it("자동완성 팝업이 열려 있으면 키 입력을 에디터로 위임한다", () => {
		const withAutocomplete = createController([{ id: "text", type: "text", prompt: "Explain" }]);
		withAutocomplete.editor.isShowingAutocomplete = () => true;
		withAutocomplete.controller.handleInput("\r");
		expect(withAutocomplete.done).not.toHaveBeenCalled();
		expect(withAutocomplete.editor.handledInputs).toContain("\r");
		withAutocomplete.controller.handleInput("\u001b");
		expect(withAutocomplete.done).not.toHaveBeenCalled();
		expect(withAutocomplete.editor.handledInputs).toContain("\u001b");
	});

	it("기타 입력 중 자동완성 팝업이 열려 있으면 키 입력을 에디터로 위임한다", () => {
		const other = createController([
			{ id: "radio", type: "radio", prompt: "Pick one", options: [{ value: "a", label: "Alpha" }] },
		]);
		other.controller.handleInput("\u001b[B");
		other.controller.handleInput("\r");
		expect(other.controller.getState().otherMode).toBe(true);
		other.editor.isShowingAutocomplete = () => true;
		other.controller.handleInput("\r");
		expect(other.controller.getState().otherMode).toBe(true);
		expect(other.editor.handledInputs).toContain("\r");
		other.editor.isShowingAutocomplete = () => false;
		other.controller.handleInput("\u001b");
		expect(other.controller.getState().otherMode).toBe(false);
		expect(other.done).not.toHaveBeenCalled();
	});
});
