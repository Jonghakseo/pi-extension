export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

export interface Question {
	id: string;
	type: "radio" | "checkbox" | "text";
	prompt: string;
	label?: string;
	options?: QuestionOption[];
	allowOther?: boolean;
	required?: boolean;
	placeholder?: string;
	default?: string | string[];
}

export interface AskUserQuestionParamsInput {
	title?: string;
	description?: string;
	questions: Question[];
}

export interface NormalizedQuestion extends Question {
	label: string;
	options: QuestionOption[];
	allowOther: boolean;
	required: boolean;
}

export interface Answer {
	id: string;
	type: "radio" | "checkbox" | "text";
	value: string | string[];
	wasCustom: boolean;
}

export interface FormResult {
	title?: string;
	questions: NormalizedQuestion[];
	answers: Answer[];
	cancelled: boolean;
}

export interface RadioAnswer {
	value: string;
	label: string;
	wasCustom: boolean;
}

export interface AnswerState {
	radioAnswers: Map<string, RadioAnswer>;
	checkAnswers: Map<string, Set<string>>;
	checkCustom: Map<string, string>;
	textAnswers: Map<string, string>;
}

export interface RenderTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

export interface EditorAdapter {
	onSubmit?: (value: string) => void;
	getText(): string;
	setText(text: string): void;
	handleInput(data: string): void;
	render(width: number): string[];
}

export interface RenderFormInput {
	title?: string;
	description?: string;
	questions: NormalizedQuestion[];
	answerState: AnswerState;
	currentTab: number;
	cursorIdx: number;
	otherMode: boolean;
	width: number;
	theme: RenderTheme;
	editorLines: string[];
	editorText: string;
}
