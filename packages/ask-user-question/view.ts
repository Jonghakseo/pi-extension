import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { SYM } from "./constants.ts";
import { allRequiredAnswered, isAnswered } from "./state.ts";
import type { RenderFormInput } from "./types.ts";

function createLineHelpers(width: number, theme: RenderFormInput["theme"]) {
	const lines: string[] = [];
	const maxWidth = Math.min(width, 120);
	const add = (text: string) => lines.push(...wrapTextWithAnsi(text, maxWidth));
	const hr = () => add(theme.fg("accent", "─".repeat(maxWidth)));
	return { lines, maxWidth, add, hr };
}

export function renderSubmitTab(input: RenderFormInput, add: (text: string) => void): void {
	const { questions, answerState, theme } = input;
	add(` ${theme.fg("accent", theme.bold("검토 및 제출"))}`);
	add("");

	for (const question of questions) {
		const label = theme.fg("muted", `${question.label}:`);
		if (question.type === "radio") {
			const answer = answerState.radioAnswers.get(question.id);
			if (answer) {
				const prefix = answer.wasCustom ? theme.fg("dim", "(직접 입력) ") : "";
				add(` ${label} ${prefix}${answer.label}`);
			} else {
				add(` ${label} ${theme.fg("warning", "(미응답)")}`);
			}
			continue;
		}

		if (question.type === "checkbox") {
			const selected = answerState.checkAnswers.get(question.id) ?? new Set<string>();
			const custom = answerState.checkCustom.get(question.id)?.trim();
			const values = [...selected];
			if (custom) values.push(`${theme.fg("dim", "(직접 입력)")} ${custom}`);
			add(` ${label} ${values.length ? values.join(", ") : theme.fg("warning", "(미응답)")}`);
			continue;
		}

		const answer = answerState.textAnswers.get(question.id)?.trim();
		if (answer) {
			add(` ${label} ${answer}`);
		} else {
			add(` ${label} ${theme.fg("warning", "(미응답)")}`);
		}
	}

	add("");
	if (allRequiredAnswered(answerState, questions)) {
		add(` ${theme.fg("success", "Enter로 제출")}`);
	} else {
		const missing = questions
			.filter((question) => question.required && !isAnswered(answerState, question))
			.map((question) => question.label)
			.join(", ");
		add(` ${theme.fg("warning", `필수 응답: ${missing}`)}`);
	}

	add("");
	add(theme.fg("dim", " Tab/←→ 질문 이동 • Enter 제출 • Esc 취소"));
}

export function renderTabBar(input: RenderFormInput, add: (text: string) => void): void {
	const { questions, answerState, currentTab, theme } = input;
	if (questions.length <= 1) return;

	const tabs: string[] = [];
	for (let index = 0; index < questions.length; index += 1) {
		const active = index === currentTab;
		const answered = isAnswered(answerState, questions[index]);
		const icon = answered ? theme.fg("success", SYM.check) : theme.fg("dim", SYM.dot);
		const text = ` ${icon} ${questions[index].label} `;
		tabs.push(active ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text));
	}

	const submitActive = currentTab === questions.length;
	const submitText = ` ${SYM.submit} 제출 `;
	tabs.push(
		submitActive
			? theme.bg("selectedBg", theme.fg("text", submitText))
			: theme.fg(allRequiredAnswered(answerState, questions) ? "success" : "dim", submitText),
	);

	add(` ${tabs.join(theme.fg("dim", "│"))}`);
	add("");
}

export function renderQuestion(input: RenderFormInput, add: (text: string) => void, maxWidth: number): void {
	const question = input.questions[input.currentTab];
	if (!question) return;

	const typeTag =
		question.type === "radio"
			? input.theme.fg("dim", "[단일 선택]")
			: question.type === "checkbox"
				? input.theme.fg("dim", "[복수 선택]")
				: input.theme.fg("dim", "[텍스트]");

	add(` ${input.theme.fg("text", input.theme.bold(question.prompt))} ${typeTag}`);
	if (question.required) add(` ${input.theme.fg("warning", "*필수")}`);
	add("");

	if (question.type === "radio") {
		const selected = input.answerState.radioAnswers.get(question.id);
		for (let index = 0; index < question.options.length; index += 1) {
			const option = question.options[index];
			const isCursor = index === input.cursorIdx;
			const isSelected = selected?.value === option.value && !selected.wasCustom;
			const bullet = isSelected ? input.theme.fg("accent", SYM.radioOn) : input.theme.fg("dim", SYM.radioOff);
			const pointer = isCursor ? input.theme.fg("accent", SYM.pointer) : " ";
			add(` ${pointer} ${bullet} ${input.theme.fg(isCursor ? "accent" : isSelected ? "text" : "muted", option.label)}`);
			if (option.description) add(`      ${input.theme.fg("dim", option.description)}`);
		}

		if (question.allowOther) {
			const isCursor = input.cursorIdx === question.options.length;
			const isSelected = selected?.wasCustom === true;
			const bullet = isSelected ? input.theme.fg("accent", SYM.radioOn) : input.theme.fg("dim", SYM.radioOff);
			const pointer = isCursor ? input.theme.fg("accent", SYM.pointer) : " ";
			const label = isSelected ? `기타: ${selected.label}` : "기타...";
			add(` ${pointer} ${bullet} ${input.theme.fg(isCursor ? "accent" : "muted", label)}`);
		}
	}

	if (question.type === "checkbox") {
		const selected = input.answerState.checkAnswers.get(question.id) ?? new Set<string>();
		for (let index = 0; index < question.options.length; index += 1) {
			const option = question.options[index];
			const isCursor = index === input.cursorIdx;
			const isChecked = selected.has(option.value);
			const box = isChecked ? input.theme.fg("accent", SYM.checkOn) : input.theme.fg("dim", SYM.checkOff);
			const pointer = isCursor ? input.theme.fg("accent", SYM.pointer) : " ";
			add(` ${pointer} ${box} ${input.theme.fg(isCursor ? "accent" : isChecked ? "text" : "muted", option.label)}`);
			if (option.description) add(`      ${input.theme.fg("dim", option.description)}`);
		}

		if (question.allowOther) {
			const isCursor = input.cursorIdx === question.options.length;
			const custom = input.answerState.checkCustom.get(question.id)?.trim();
			const box = custom ? input.theme.fg("accent", SYM.checkOn) : input.theme.fg("dim", SYM.checkOff);
			const pointer = isCursor ? input.theme.fg("accent", SYM.pointer) : " ";
			const label = custom ? `기타: ${custom}` : "기타...";
			add(` ${pointer} ${box} ${input.theme.fg(isCursor ? "accent" : "muted", label)}`);
		}
	}

	if (input.otherMode) {
		add("");
		add(` ${input.theme.fg("muted", "  직접 입력:")}`);
		for (const line of input.editorLines) add(`   ${line}`);
		return;
	}

	if (question.type === "text") {
		if (question.placeholder && !input.editorText) {
			add(` ${input.theme.fg("dim", question.placeholder)}`);
		}
		for (const line of input.editorLines) {
			add(`  ${line}`);
		}
	}

	if (question.type === "text" && input.editorLines.length === 0) {
		add(`  ${truncateToWidth("", maxWidth - 2)}`);
	}
}

export function renderFooter(input: RenderFormInput, add: (text: string) => void): void {
	const question = input.questions[input.currentTab];
	if (!question) return;
	add("");
	if (input.otherMode) {
		add(input.theme.fg("dim", " Enter 제출 • Esc 돌아가기"));
		return;
	}
	if (question.type === "text") {
		const nav = input.questions.length > 1 ? "Tab/←→ 이동 • " : "";
		add(input.theme.fg("dim", ` ${nav}Enter 제출 • Esc 취소`));
		return;
	}
	if (question.type === "checkbox") {
		const nav = input.questions.length > 1 ? "Tab/←→ 이동 • " : "";
		const enterAction = input.questions.length > 1 ? "다음" : "제출";
		add(input.theme.fg("dim", ` ↑↓ 이동 • Space 토글 • ${nav}Enter ${enterAction} • Esc 취소`));
		return;
	}
	const nav = input.questions.length > 1 ? "Tab/←→ 이동 • " : "";
	add(input.theme.fg("dim", ` ↑↓ 이동 • ${nav}Enter 선택 • Esc 취소`));
}

export function renderForm(input: RenderFormInput): string[] {
	const { lines, maxWidth, add, hr } = createLineHelpers(input.width, input.theme);
	hr();

	if (input.title) add(` ${input.theme.fg("accent", input.theme.bold(input.title))}`);
	if (input.description) add(` ${input.theme.fg("muted", input.description)}`);
	if (input.title || input.description) add("");

	renderTabBar(input, add);

	if (input.questions.length > 1 && input.currentTab === input.questions.length) {
		renderSubmitTab(input, add);
		hr();
		return lines;
	}

	if (!input.questions[input.currentTab]) {
		hr();
		return lines;
	}

	renderQuestion(input, add, maxWidth);
	renderFooter(input, add);
	hr();
	return lines;
}
