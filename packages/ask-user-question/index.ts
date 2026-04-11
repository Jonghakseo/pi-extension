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

const TOOL_DESCRIPTION = `인터랙티브 폼으로 사용자에게 하나 이상의 질문을 묻습니다. 지원하는 질문 유형은 다음 세 가지입니다:
- **radio**: 미리 정의된 보기 중 하나를 고르는 단일 선택
- **checkbox**: 여러 보기를 동시에 고르는 복수 선택
- **text**: 자유롭게 입력하는 텍스트 답변

radio/checkbox 질문에는 사용자가 직접 값을 입력할 수 있는 "기타..." 옵션을 포함할 수 있습니다.

요구사항을 확인하거나, 선호도를 물어보거나, 구현 방향에 대한 결정을 받아야 할 때 사용하세요. 일반 텍스트로 질문을 던지는 대신 이 도구를 우선 사용합니다.`;

const PROMPT_GUIDELINES = [
	"구조화된 사용자 입력이 필요하면 일반 텍스트 질문 대신 ask_user_question을 사용하세요.",
	"단일 선택은 radio, 복수 선택은 checkbox, 서술형 답변은 text를 우선 사용하세요.",
	"선택지가 완전히 닫혀 있지 않다면 allowOther: true로 '기타' 입력 경로를 열어두세요.",
	"관련 질문은 여러 번 나누지 말고 한 번의 호출에 묶어 전달하세요.",
];

function buildCancelledResponse(result: FormResult) {
	return {
		content: [{ type: "text" as const, text: "사용자가 입력 폼을 취소했습니다" }],
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
		label: "사용자 질문",
		description: TOOL_DESCRIPTION,
		promptSnippet: "radio, checkbox, text 입력을 사용하는 인터랙티브 질문 폼 열기",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: AskUserQuestionParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("오류: UI를 사용할 수 없습니다. 현재 비대화형 모드에서 실행 중입니다.");
			}

			const params = rawParams as AskUserQuestionParamsInput;
			if (!params.questions.length) {
				return errorResult("오류: 질문이 제공되지 않았습니다.");
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
