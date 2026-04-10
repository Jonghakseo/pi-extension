import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import askUserQuestionExtension from "./index.ts";

describe("ask-user-question extension", () => {
	it("returns an error for an empty question", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const result = await execute("call-1", { question: "   " }, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(result).toMatchObject({
			isError: true,
			details: { cancelled: true, question: "" },
		});
	});

	it("returns an error when interactive UI is unavailable", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const result = await execute("call-1b", { question: "Need input" }, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(result).toMatchObject({
			isError: true,
			content: [{ type: "text", text: "AskUserQuestion requires interactive mode (UI unavailable)." }],
		});
	});

	it("returns the selected option for single-choice prompts", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const notify = vi.fn();
		const select = vi.fn(async () => "Alpha");
		const result = await execute("call-2", { question: "Pick one", options: ["Alpha", "Beta"] }, undefined, undefined, {
			hasUI: true,
			ui: { notify, select },
		} as unknown as ExtensionContext);

		expect(notify).toHaveBeenCalledWith("Waiting for input", "info");
		expect(select).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Alpha" }],
			details: {
				answer: "Alpha",
				answers: ["Alpha"],
				selectedIndex: 1,
				selectedOption: "Alpha",
			},
		});
	});

	it("supports multi-select answers with custom input", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const selections = ["☐ 1. Alpha", "Other (type your own)", "Done selecting (2 selected)"];
		const select = vi.fn(async () => selections.shift());
		const input = vi.fn(async () => "Custom");
		const result = await execute(
			"call-3",
			{ question: "Pick many", options: ["Alpha", "Beta"], allowMultiple: true },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: { notify: vi.fn(), select, input },
			} as unknown as ExtensionContext,
		);

		expect(input).toHaveBeenCalledWith("Your answer", "");
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Alpha, Custom" }],
			details: {
				answers: ["Alpha", "Custom"],
				selectedIndices: [1],
				customInput: "Custom",
			},
		});
	});

	it("supports free-text answers and empty-answer fallbacks", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const input = vi.fn().mockResolvedValueOnce("  hello  ").mockResolvedValueOnce("   ");
		const ctx = {
			hasUI: true,
			ui: { notify: vi.fn(), input },
		} as unknown as ExtensionContext;

		const answered = await execute("call-4", { question: "Type" }, undefined, undefined, ctx);
		const empty = await execute("call-5", { question: "Type" }, undefined, undefined, ctx);

		expect(answered).toMatchObject({
			content: [{ type: "text", text: "hello" }],
			details: { answer: "hello", answers: ["hello"] },
		});
		expect(empty).toMatchObject({
			content: [{ type: "text", text: "(empty answer)" }],
			details: { answer: "", answers: [""] },
		});
	});

	it("cancels when custom input is abandoned or multi-select closes early", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const singleCancel = await execute(
			"call-6",
			{ question: "Pick", options: ["Alpha"], allowCustomAnswer: true },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					notify: vi.fn(),
					select: vi.fn(async () => "Other (type your own)"),
					input: vi.fn(async () => undefined),
				},
			} as unknown as ExtensionContext,
		);

		const multiCancel = await execute(
			"call-7",
			{ question: "Pick many", options: ["Alpha"], allowMultiple: true },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					notify: vi.fn(),
					select: vi.fn(async () => undefined),
					input: vi.fn(),
				},
			} as unknown as ExtensionContext,
		);

		expect(singleCancel).toMatchObject({ details: { cancelled: true } });
		expect(multiCancel).toMatchObject({ details: { cancelled: true } });
	});

	it("ignores empty custom multi-select answers until a real selection exists", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const notify = vi.fn();
		const selections = [
			"Other (type your own)",
			"Done selecting (0 selected)",
			"☐ 1. Alpha",
			"Done selecting (1 selected)",
		];
		const select = vi.fn(async () => selections.shift());
		const input = vi.fn(async () => "   ");
		const result = await execute(
			"call-8",
			{ question: "Pick many", options: ["Alpha"], allowMultiple: true },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: { notify, select, input },
			} as unknown as ExtensionContext,
		);

		expect(notify).toHaveBeenCalledWith("Empty custom answer ignored.", "warning");
		expect(notify).toHaveBeenCalledWith("Select at least one option before finishing.", "warning");
		expect(result).toMatchObject({ details: { answers: ["Alpha"], selectedIndices: [1] } });
	});

	it("supports removing custom answers and ignoring unknown multi-select labels", async () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		const execute = tool.execute;
		if (!execute) throw new Error("AskUserQuestion execute is missing");

		const selections = [
			"Other (type your own)",
			"not-a-real-option",
			"☑ custom 1. Custom",
			"☐ 1. Alpha",
			"Done selecting (1 selected)",
		];
		const select = vi.fn(async () => selections.shift());
		const input = vi.fn(async () => "Custom");
		const result = await execute(
			"call-8b",
			{ question: "Pick many", options: ["Alpha"], allowMultiple: true },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: { notify: vi.fn(), select, input },
			} as unknown as ExtensionContext,
		);

		expect(result).toMatchObject({ details: { answers: ["Alpha"], selectedIndices: [1], customInput: undefined } });
	});

	it("renders call and result summaries across the major branches", () => {
		const apiMock = createExtensionApiMock();
		askUserQuestionExtension(apiMock.api);
		const tool = apiMock.getTool("AskUserQuestion");
		if (!tool.renderCall || !tool.renderResult) throw new Error("renderers are missing");

		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as const;

		expect(tool.renderCall({ question: "Q", context: "Ctx" }, theme)).toBeTruthy();
		expect(
			tool.renderCall(
				{
					question: "Q",
					options: ["One", "Two", "Three", "Four", "Five"],
					allowMultiple: true,
					allowCustomAnswer: false,
				},
				theme,
			),
		).toBeTruthy();
		expect(tool.renderResult({ content: [{ type: "text", text: "plain" }] }, {}, theme)).toBeTruthy();
		expect(
			tool.renderResult({ details: { cancelled: true }, content: [{ type: "text", text: "plain" }] }, {}, theme),
		).toBeTruthy();
		expect(
			tool.renderResult(
				{
					details: { allowMultiple: true, answers: ["A", "B"], customInput: "B" },
					content: [{ type: "text", text: "A, B" }],
				},
				{},
				theme,
			),
		).toBeTruthy();
		expect(
			tool.renderResult(
				{
					details: { answer: "Alpha", selectedOption: "Alpha", selectedIndex: 1 },
					content: [{ type: "text", text: "Alpha" }],
				},
				{},
				theme,
			),
		).toBeTruthy();
		expect(
			tool.renderResult(
				{ details: { answer: "typed", selectedOption: "custom" }, content: [{ type: "text", text: "typed" }] },
				{},
				theme,
			),
		).toBeTruthy();
	});
});
