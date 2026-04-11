import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { runAskUserQuestionForm } from "./form-ui.ts";
import {
	buildRenderCallText,
	buildRenderResultText,
	errorResult,
	formatResultContent,
	renderCall,
	renderResult,
} from "./output.ts";
import { AskUserQuestionParams } from "./schema.ts";
import { normalizeQuestions } from "./state.ts";
import type { AskUserQuestionParamsInput, FormResult, Question } from "./types.ts";

const TOOL_DESCRIPTION = `Ask the user one or more questions using an interactive form. Supports three question types:
- **radio**: Single-select from predefined options (like multiple choice)
- **checkbox**: Multi-select from options (pick all that apply)
- **text**: Free-form text input

Each radio/checkbox question can include an "Other..." option that lets the user type a custom answer.

Use this tool when you need user input to proceed — for clarifying requirements, getting preferences, confirming decisions, or choosing between alternatives. Prefer this over asking plain-text questions in your response.`;

const PROMPT_GUIDELINES = [
	"Use ask_user_question instead of asking questions in plain text when you need structured user input.",
	"Prefer radio for single-choice, checkbox for multi-choice, text for open-ended answers.",
	"Always include an 'Other' escape hatch (allowOther: true) unless the options are exhaustive.",
	"Group related questions in a single call rather than making multiple separate calls.",
];

function buildCancelledResponse(result: FormResult) {
	return {
		content: [{ type: "text" as const, text: "User cancelled the form" }],
		details: result,
	};
}

function buildSuccessResponse(result: FormResult) {
	return {
		content: [{ type: "text" as const, text: formatResultContent(result) }],
		details: result,
	};
}

export type { AskUserQuestionParamsInput, FormResult, Question };
export { AskUserQuestionParams, buildRenderCallText, buildRenderResultText, errorResult, normalizeQuestions };

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Ask the user interactive questions with radio, checkbox, or text inputs",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: AskUserQuestionParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}

			const params = rawParams as AskUserQuestionParamsInput;
			if (!params.questions.length) {
				return errorResult("Error: No questions provided");
			}

			const questions = normalizeQuestions(params.questions as Question[]);
			const result = await runAskUserQuestionForm(
				ctx,
				{ title: params.title, description: params.description },
				questions,
			);
			return result.cancelled ? buildCancelledResponse(result) : buildSuccessResponse(result);
		},
		renderCall(args, theme) {
			return renderCall(
				{ questions: args.questions as Question[] | undefined, title: args.title as string | undefined },
				theme,
			);
		},
		renderResult(result, _options, theme) {
			return renderResult(result as { content?: Array<{ type: string; text?: string }>; details?: FormResult }, theme);
		},
	});
}
