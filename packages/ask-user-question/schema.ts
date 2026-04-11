import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

export const OptionSchema = Type.Object({
	value: Type.String({ description: "Value returned when selected" }),
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Help text shown below the label" })),
});

export const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	type: StringEnum(["radio", "checkbox", "text"] as const, {
		description: "Question type: radio (single-select), checkbox (multi-select), or text (free input)",
	}),
	prompt: Type.String({ description: "The question text to display" }),
	label: Type.Optional(Type.String({ description: "Short label for tab bar (defaults to Q1, Q2...)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for radio/checkbox types" })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Add an 'Other...' option with text input (default: true for radio/checkbox)" }),
	),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required (default: true)" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder for text inputs" })),
	default: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Default value(s). String for radio/text, string[] for checkbox",
		}),
	),
});

export const AskUserQuestionParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Form title displayed at the top" })),
	description: Type.Optional(Type.String({ description: "Brief context or instructions shown under the title" })),
	questions: Type.Array(QuestionSchema, {
		description:
			"One or more questions to ask. Use radio for single-select, checkbox for multi-select, text for free input",
	}),
});
