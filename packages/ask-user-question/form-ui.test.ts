import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
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
