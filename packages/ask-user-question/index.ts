import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AskUserQuestionDetails {
	question: string;
	context?: string;
	options: string[];
	allowCustomAnswer: boolean;
	allowMultiple: boolean;
	answer: string | null;
	answers: string[];
	selectedOption?: string;
	selectedOptions?: string[];
	selectedIndex?: number;
	selectedIndices?: number[];
	customInput?: string;
	cancelled: boolean;
}

const AskUserQuestionParams = Type.Object({
	question: Type.String({ description: "Question to ask the user" }),
	context: Type.Optional(Type.String({ description: "Optional extra context shown to the user" })),
	options: Type.Optional(Type.Array(Type.String(), { description: "Optional predefined options" })),
	allowCustomAnswer: Type.Optional(
		Type.Boolean({ description: "If true, allow typing a custom answer when options are provided", default: true }),
	),
	allowMultiple: Type.Optional(
		Type.Boolean({ description: "If true, allow selecting multiple options", default: false }),
	),
	placeholder: Type.Optional(Type.String({ description: "Optional input placeholder for typed answers" })),
});

const OTHER_OPTION_LABEL = "Other (type your own)";
const DONE_OPTION_LABEL = "Done selecting";

function stripMarkdownForDisplay(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s{0,3}>\s?/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "• ")
		.replace(/^\s*\d+\.\s+/gm, "• ")
		.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/(^|[^*])\*([^*\n]+)\*(?=[^*]|$)/g, "$1$2")
		.replace(/(^|[^_])_([^_\n]+)_(?=[^_]|$)/g, "$1$2")
		.replace(/^\s*([-*_]\s*){3,}$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function toDisplayText(text: string): string {
	const stripped = stripMarkdownForDisplay(text).trim();
	return stripped || text.trim() || "(empty)";
}

function buildDisplayOptions(options: string[]): string[] {
	const base = options.map((option) => toDisplayText(option));
	const counts = new Map<string, number>();
	for (const label of base) counts.set(label, (counts.get(label) ?? 0) + 1);
	return base.map((label, index) => ((counts.get(label) ?? 0) > 1 ? `${index + 1}. ${label}` : label));
}

function normalizeOptions(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const dedup = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const normalized = item.trim();
		if (!normalized) continue;
		dedup.add(normalized);
	}
	return Array.from(dedup);
}

function buildPrompt(question: string, context?: string): string {
	const normalizedQuestion = toDisplayText(question);
	const ctx = typeof context === "string" ? toDisplayText(context) : "";
	if (!ctx) return normalizedQuestion;
	return `${normalizedQuestion}\n\n${ctx}`;
}

function clampLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const hidden = lines.length - maxLines;
	const visible = lines.slice(0, maxLines);
	const lastIndex = visible.length - 1;
	visible[lastIndex] = `${visible[lastIndex]} … (+${hidden} lines)`;
	return visible.join("\n");
}

function buildDetails(
	base: Omit<AskUserQuestionDetails, "answer" | "answers" | "cancelled"> & {
		answer?: string | null;
		answers?: string[];
		cancelled?: boolean;
	},
): AskUserQuestionDetails {
	return {
		...base,
		answer: base.answer ?? null,
		answers: base.answers ?? [],
		cancelled: base.cancelled ?? false,
	};
}

function buildCancelledResult(
	question: string,
	context: string | undefined,
	options: string[],
	allowCustomAnswer: boolean,
	allowMultiple: boolean,
) {
	return {
		content: [{ type: "text" as const, text: "User cancelled AskUserQuestion." }],
		details: buildDetails({
			question,
			context,
			options,
			allowCustomAnswer,
			allowMultiple,
			cancelled: true,
		}),
	};
}

function buildExecutionParams(params: Record<string, unknown>): AskUserQuestionExecutionParams {
	return {
		question: typeof params.question === "string" ? params.question.trim() : "",
		context: typeof params.context === "string" ? params.context.trim() : undefined,
		options: normalizeOptions(params.options),
		allowCustomAnswer: typeof params.allowCustomAnswer === "boolean" ? params.allowCustomAnswer : true,
		allowMultiple: typeof params.allowMultiple === "boolean" ? params.allowMultiple : false,
		placeholder: typeof params.placeholder === "string" ? params.placeholder : "",
	};
}

function buildAskUserQuestionErrorResult(message: string, params: AskUserQuestionExecutionParams) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildDetails({
			question: params.question,
			context: params.context,
			options: params.options,
			allowCustomAnswer: params.allowCustomAnswer,
			allowMultiple: params.allowMultiple,
			cancelled: true,
		}),
		isError: true,
	};
}

async function askSingleChoice(
	ctx: ExtensionContext,
	params: AskUserQuestionExecutionParams,
): Promise<AskSingleChoiceResult | undefined> {
	if (params.options.length > 0) {
		const displayOptions = buildDisplayOptions(params.options);
		const selectable = params.allowCustomAnswer ? [...displayOptions, OTHER_OPTION_LABEL] : [...displayOptions];
		const selected = await ctx.ui.select(buildPrompt(params.question, params.context), selectable);
		if (selected === undefined) return undefined;
		if (selected === OTHER_OPTION_LABEL) {
			const customInput = await promptForCustomInput(ctx, params.placeholder);
			if (customInput === undefined) return undefined;
			return {
				answer: customInput,
				selectedOption: "custom",
				customInput,
			};
		}

		const optionIndex = displayOptions.indexOf(selected);
		return {
			answer: optionIndex >= 0 ? params.options[optionIndex] : selected,
			selectedOption: optionIndex >= 0 ? params.options[optionIndex] : selected,
			selectedIndex: optionIndex >= 0 ? optionIndex + 1 : undefined,
		};
	}

	const answer = await ctx.ui.input(buildPrompt(params.question, params.context), params.placeholder);
	if (answer === undefined) return undefined;
	return {
		answer,
		customInput: answer.trim() || undefined,
	};
}

type MultiSelectResult = {
	cancelled: boolean;
	answers: string[];
	selectedIndices: number[];
	customInput?: string;
};

type AskSingleChoiceResult = {
	answer: string;
	selectedOption?: string;
	selectedIndex?: number;
	customInput?: string;
};

type AskUserQuestionExecutionParams = {
	question: string;
	context?: string;
	options: string[];
	allowCustomAnswer: boolean;
	allowMultiple: boolean;
	placeholder: string;
};

type OptionEntry =
	| { kind: "option"; label: string; optionIndex: number }
	| { kind: "custom"; label: string; customIndex: number }
	| { kind: "other"; label: string }
	| { kind: "done"; label: string };

async function promptForCustomInput(ctx: ExtensionContext, placeholder: string): Promise<string | undefined> {
	const answer = await ctx.ui.input("Your answer", placeholder);
	if (answer === undefined) return undefined;
	const normalized = answer.trim();
	if (!normalized) {
		ctx.ui.notify("Empty custom answer ignored.", "warning");
		return "";
	}
	return normalized;
}

function buildMultiSelectEntries(
	displayOptions: string[],
	selectedOptionIndices: Set<number>,
	allowCustomAnswer: boolean,
	customAnswers: string[],
): OptionEntry[] {
	const entries: OptionEntry[] = displayOptions.map((option, index) => ({
		kind: "option",
		optionIndex: index,
		label: `${selectedOptionIndices.has(index) ? "☑" : "☐"} ${index + 1}. ${option}`,
	}));

	if (!allowCustomAnswer) {
		return entries;
	}

	entries.push({ kind: "other", label: OTHER_OPTION_LABEL });
	customAnswers.forEach((answer, index) => {
		entries.push({ kind: "custom", customIndex: index, label: `☑ custom ${index + 1}. ${answer}` });
	});
	return entries;
}

function buildSelectedSummary(
	displayOptions: string[],
	selectedOptionIndices: Set<number>,
	customAnswers: string[],
): string[] {
	return [
		...Array.from(selectedOptionIndices)
			.sort((a, b) => a - b)
			.map((index) => displayOptions[index]),
		...customAnswers,
	];
}

function findSelectedEntry(entries: OptionEntry[], choice: string): OptionEntry | undefined {
	return entries.find((entry) => entry.label === choice);
}

function finalizeMultiSelect(
	ctx: ExtensionContext,
	options: string[],
	selectedOptionIndices: Set<number>,
	customAnswers: string[],
): MultiSelectResult | null {
	const answers = [
		...Array.from(selectedOptionIndices)
			.sort((a, b) => a - b)
			.map((index) => options[index]),
		...customAnswers,
	];
	if (answers.length === 0) {
		ctx.ui.notify("Select at least one option before finishing.", "warning");
		return null;
	}
	return {
		cancelled: false,
		answers,
		selectedIndices: Array.from(selectedOptionIndices)
			.sort((a, b) => a - b)
			.map((index) => index + 1),
		customInput: customAnswers.length > 0 ? customAnswers.join(", ") : undefined,
	};
}

async function handleMultiSelectEntry(
	ctx: ExtensionContext,
	entry: OptionEntry,
	selectedOptionIndices: Set<number>,
	customAnswers: string[],
	options: string[],
	placeholder: string,
): Promise<MultiSelectResult | null> {
	if (entry.kind === "option") {
		if (selectedOptionIndices.has(entry.optionIndex)) selectedOptionIndices.delete(entry.optionIndex);
		else selectedOptionIndices.add(entry.optionIndex);
		return null;
	}

	if (entry.kind === "custom") {
		customAnswers.splice(entry.customIndex, 1);
		return null;
	}

	if (entry.kind === "other") {
		const customAnswer = await promptForCustomInput(ctx, placeholder);
		if (customAnswer && !customAnswers.includes(customAnswer)) {
			customAnswers.push(customAnswer);
		}
		return null;
	}

	return finalizeMultiSelect(ctx, options, selectedOptionIndices, customAnswers);
}

async function askMultipleOptions(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: string[],
	allowCustomAnswer: boolean,
	placeholder: string,
): Promise<MultiSelectResult> {
	const selectedOptionIndices = new Set<number>();
	const customAnswers: string[] = [];
	const displayOptions = options.map((option) => toDisplayText(option));

	while (true) {
		const selectedSummary = buildSelectedSummary(displayOptions, selectedOptionIndices, customAnswers);
		const entries = buildMultiSelectEntries(displayOptions, selectedOptionIndices, allowCustomAnswer, customAnswers);
		entries.push({ kind: "done", label: `${DONE_OPTION_LABEL} (${selectedSummary.length} selected)` });

		const choice = await ctx.ui.select(
			`${buildPrompt(question, context)}\n\nSelected: ${selectedSummary.length > 0 ? selectedSummary.join(", ") : "(none)"}`,
			entries.map((entry) => entry.label),
		);

		if (choice === undefined) {
			return { cancelled: true, answers: [], selectedIndices: [] };
		}

		const selectedEntry = findSelectedEntry(entries, choice);
		if (!selectedEntry) continue;

		const result = await handleMultiSelectEntry(
			ctx,
			selectedEntry,
			selectedOptionIndices,
			customAnswers,
			options,
			placeholder,
		);
		if (result) {
			return result;
		}
	}
}

export default function askUserQuestionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "AskUserQuestion",
		label: "AskUserQuestion",
		description:
			"Ask the user a question and wait for their response. Use this when you need to:\n" +
			"1. Gather user preferences or requirements\n" +
			"2. Clarify ambiguous instructions\n" +
			"3. Get decisions on implementation choices as you work\n" +
			"4. Offer choices to the user about what direction to take\n\n" +
			"Usage notes:\n" +
			'- Users will always be able to select "Other" to provide custom text input\n' +
			"- Use allowMultiple: true to allow multiple answers to be selected for a question\n" +
			'- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label\n' +
			'- Do NOT use this tool to ask "Should I proceed?" or seek unnecessary confirmation — just proceed with the task',
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const executionParams = buildExecutionParams(params as Record<string, unknown>);
			const { question, context, options, allowCustomAnswer, allowMultiple } = executionParams;

			if (!question) {
				return buildAskUserQuestionErrorResult("AskUserQuestion requires a non-empty question.", executionParams);
			}

			if (!ctx.hasUI) {
				return buildAskUserQuestionErrorResult(
					"AskUserQuestion requires interactive mode (UI unavailable).",
					executionParams,
				);
			}

			ctx.ui.notify("Waiting for input", "info");

			if (allowMultiple && options.length > 0) {
				const multipleResult = await askMultipleOptions(
					ctx,
					question,
					context,
					options,
					allowCustomAnswer,
					executionParams.placeholder,
				);
				if (multipleResult.cancelled) {
					return buildCancelledResult(question, context, options, allowCustomAnswer, allowMultiple);
				}

				const answerText = multipleResult.answers.join(", ");
				return {
					content: [{ type: "text" as const, text: answerText }],
					details: buildDetails({
						question,
						context,
						options,
						allowCustomAnswer,
						allowMultiple,
						answer: answerText,
						answers: multipleResult.answers,
						selectedOptions: multipleResult.answers,
						selectedIndices: multipleResult.selectedIndices,
						customInput: multipleResult.customInput,
					}),
				};
			}

			const singleChoice = await askSingleChoice(ctx, executionParams);
			if (!singleChoice) {
				return buildCancelledResult(question, context, options, allowCustomAnswer, allowMultiple);
			}

			const normalizedAnswer = singleChoice.answer.trim();
			return {
				content: [{ type: "text" as const, text: normalizedAnswer || "(empty answer)" }],
				details: buildDetails({
					question,
					context,
					options,
					allowCustomAnswer,
					allowMultiple,
					answer: normalizedAnswer,
					answers: [normalizedAnswer],
					selectedOption: singleChoice.selectedOption,
					selectedOptions:
						singleChoice.selectedOption && singleChoice.selectedOption !== "custom"
							? [singleChoice.selectedOption]
							: normalizedAnswer
								? [normalizedAnswer]
								: [],
					selectedIndex: singleChoice.selectedIndex,
					selectedIndices: singleChoice.selectedIndex ? [singleChoice.selectedIndex] : undefined,
					customInput: singleChoice.selectedOption === "custom" ? normalizedAnswer : singleChoice.customInput,
				}),
			};
		},

		renderCall(args, theme) {
			const question = typeof args.question === "string" ? toDisplayText(args.question) : "(no question)";
			const context = typeof args.context === "string" && args.context.trim() ? toDisplayText(args.context) : "";
			const options = buildDisplayOptions(normalizeOptions(args.options));
			const allowCustomAnswer = args.allowCustomAnswer ?? true;
			const allowMultiple = args.allowMultiple ?? false;

			let text = `${theme.fg("toolTitle", theme.bold("AskUserQuestion"))} ${theme.fg("accent", question)}`;
			if (options.length > 0) {
				const renderedOptions = allowCustomAnswer ? [...options, "Other"] : options;
				text += `\n${theme.fg("dim", `options:${renderedOptions.length}${allowMultiple ? " · multi" : ""}`)}`;
				for (let i = 0; i < Math.min(renderedOptions.length, 4); i++) {
					text += `\n${theme.fg("muted", `- ${renderedOptions[i]}`)}`;
				}
				if (renderedOptions.length > 4) {
					text += `\n${theme.fg("muted", `… ${renderedOptions.length - 4} more`)}`;
				}
			} else if (context) {
				text += `\n${theme.fg("muted", context)}`;
			}
			return new Text(clampLines(text, 6), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.allowMultiple) {
				const answers = details.answers?.filter((answer) => answer?.trim()) ?? [];
				let text =
					theme.fg("success", "✓ ") +
					theme.fg("muted", `selected ${answers.length}: `) +
					theme.fg("accent", answers.length > 0 ? answers.join(", ") : "(none)");
				if (details.customInput) {
					text += `\n${theme.fg("dim", `custom: ${details.customInput}`)}`;
				}
				return new Text(clampLines(text, 3), 0, 0);
			}

			const answerText = details.answer ?? "";
			if (details.selectedOption && details.selectedOption !== "custom") {
				const indexPrefix = details.selectedIndex ? `${details.selectedIndex}. ` : "";
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("muted", "selected ") +
						theme.fg("accent", `${indexPrefix}${answerText}`),
					0,
					0,
				);
			}

			return new Text(
				theme.fg("success", "✓ ") + theme.fg("muted", "answered ") + theme.fg("accent", answerText || "(empty answer)"),
				0,
				0,
			);
		},
	});
}
