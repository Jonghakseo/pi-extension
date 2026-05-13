import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createEditorTheme, runAskUserQuestionForm } from "./form-ui.ts";
import { normalizeQuestions } from "./state.ts";
import type { FormResult, RenderTheme } from "./types.ts";

const theme: RenderTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => `[${text}]`,
	bold: (text) => text,
};

describe("ask-user-question/form-ui", () => {
	it("creates the editor theme mapping", () => {
		const editorTheme = createEditorTheme(theme);
		expect(editorTheme.borderColor("x")).toBe("x");
		expect(editorTheme.selectList.selectedPrefix("a")).toBe("a");
		expect(editorTheme.selectList.selectedText("b")).toBe("b");
		expect(editorTheme.selectList.description("c")).toBe("c");
		expect(editorTheme.selectList.scrollInfo("d")).toBe("d");
		expect(editorTheme.selectList.noMatch("e")).toBe("e");
	});

	it("prefers the native askUserQuestion bridge when available", async () => {
		const questions = normalizeQuestions([
			{ id: "choice", type: "radio", prompt: "Pick", options: [{ value: "a", label: "A" }] },
			{ id: "items", type: "checkbox", prompt: "Items", options: [{ value: "x", label: "X" }] },
			{ id: "note", type: "text", prompt: "Note" },
		]);
		const askUserQuestion = vi.fn(async () => ({ choice: "custom", items: ["x", "extra"], note: "ship it" }));
		const custom = vi.fn();
		const ctx = {
			hasUI: true,
			ui: { askUserQuestion, custom },
		} as unknown as ExtensionContext;

		const result = await runAskUserQuestionForm(ctx, { title: "Title", description: "Desc" }, questions);

		expect(askUserQuestion).toHaveBeenCalledWith({ title: "Title", description: "Desc", questions });
		expect(custom).not.toHaveBeenCalled();
		expect(result).toEqual({
			title: "Title",
			questions,
			answers: [
				{ id: "choice", type: "radio", value: "custom", wasCustom: true },
				{ id: "items", type: "checkbox", value: ["x", "extra"], wasCustom: true },
				{ id: "note", type: "text", value: "ship it", wasCustom: true },
			],
			cancelled: false,
		});
	});

	it("supports the snake_case bridge and maps undefined to cancellation", async () => {
		const questions = normalizeQuestions([{ id: "text", type: "text", prompt: "Explain" }]);
		const signal = new AbortController().signal;
		const askUserQuestion = vi.fn(async () => undefined);
		const ctx = {
			hasUI: true,
			ui: { ask_user_question: askUserQuestion },
		} as unknown as ExtensionContext;

		const result = await runAskUserQuestionForm(ctx, { title: "Title" }, questions, { signal });

		expect(askUserQuestion).toHaveBeenCalledWith({ title: "Title", description: undefined, questions }, { signal });
		expect(result).toEqual({ title: "Title", questions, answers: [], cancelled: true });
	});

	it("coerces unexpected native bridge answers into safe form results", async () => {
		const questions = normalizeQuestions([
			{ id: "choice", type: "radio", prompt: "Pick", options: [{ value: "a", label: "A" }] },
			{ id: "single", type: "checkbox", prompt: "Single", options: [{ value: "solo", label: "Solo" }] },
			{ id: "missing", type: "checkbox", prompt: "Missing", options: [{ value: "x", label: "X" }] },
		]);
		const askUserQuestion = vi.fn(async () => ({ choice: 123, single: "solo" }));
		const ctx = {
			hasUI: true,
			ui: { askUserQuestion },
		} as unknown as ExtensionContext;

		const result = await runAskUserQuestionForm(ctx, {}, questions);

		expect(result).toEqual({
			title: undefined,
			questions,
			answers: [
				{ id: "choice", type: "radio", value: "", wasCustom: false },
				{ id: "single", type: "checkbox", value: ["solo"], wasCustom: false },
				{ id: "missing", type: "checkbox", value: [], wasCustom: false },
			],
			cancelled: false,
		});
	});

	it("wires the custom UI factory to the controller", async () => {
		const questions = normalizeQuestions([{ id: "text", type: "text", prompt: "Explain", default: "seed" }]);
		let captured: FormResult | undefined;
		const done = vi.fn((result: unknown) => {
			captured = result as FormResult;
		});
		const requestRender = vi.fn();
		const custom = vi.fn(async (factory: Parameters<NonNullable<ExtensionContext["ui"]>["custom"]>[0]) => {
			const component = (await factory({ requestRender } as never, theme as never, {} as never, done)) as {
				handleInput(data: string): void;
			};
			component.handleInput("!");
			component.handleInput("\r");
			expect(requestRender).toHaveBeenCalled();
			if (!captured) throw new Error("result was not captured");
			return captured;
		});

		const ctx = {
			hasUI: true,
			ui: { custom },
		} as unknown as ExtensionContext;

		const result = await runAskUserQuestionForm(ctx, { title: "Title", description: "Desc" }, questions);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			title: "Title",
			questions,
			answers: [{ id: "text", type: "text", value: "seed!", wasCustom: true }],
			cancelled: false,
		});
	});
});
