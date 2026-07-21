import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteProvider,
	AutocompleteSuggestions,
	EditorComponent,
	EditorTheme,
	TUI,
} from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.js";
import { COMMAND_COMPLETION_LIMIT } from "./constants.js";

const MENTION_PREFIX_PATTERN = /(?:^|[\s([{])>(?!>)([^\s>]*)$/;
const MENTION_LEADING_BOUNDARY = "[\\s([{]";
const MENTION_TRAILING_BOUNDARY = "(?=$|[\\s.,!?;:)}\\]])";
const MENTION_HIGHLIGHT_WRAPPED = Symbol.for("pi-extension-subagent.mentionHighlightWrapped");
const ANSI_CYAN = "\x1b[36m";
const ANSI_RESET_FOREGROUND = "\x1b[39m";

type HighlightableEditor = EditorComponent & Record<PropertyKey, unknown>;
type RichEditorTheme = EditorTheme & {
	fg?: (color: string, text: string) => string;
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildAgentMentionPattern(agents: AgentConfig[]): {
	pattern: RegExp;
	canonicalNames: Map<string, string>;
} | null {
	const canonicalNames = new Map(agents.map((agent) => [agent.name.toLowerCase(), agent.name]));
	const names = Array.from(canonicalNames.values())
		.filter((name) => name.length > 0 && !/\s/.test(name))
		.sort((left, right) => right.length - left.length)
		.map(escapeRegExp);
	if (names.length === 0) return null;

	return {
		pattern: new RegExp(`(^|${MENTION_LEADING_BOUNDARY})>(${names.join("|")})${MENTION_TRAILING_BOUNDARY}`, "gim"),
		canonicalNames,
	};
}

function styleAgentMention(text: string, theme: EditorTheme): string {
	const richTheme = theme as RichEditorTheme;
	for (const color of ["subagentMention", "syntaxType", "toolTitle"]) {
		try {
			const styled = richTheme.fg?.(color, text);
			if (styled && styled !== text) return styled;
		} catch {
			// Custom theme keys are optional.
		}
	}
	return theme.selectList?.selectedText?.(text) ?? `${ANSI_CYAN}${text}${ANSI_RESET_FOREGROUND}`;
}

/** Return the incomplete agent name after a mention marker at the cursor. */
export function extractAgentMentionQuery(textBeforeCursor: string): string | undefined {
	return MENTION_PREFIX_PATTERN.exec(textBeforeCursor)?.[1];
}

/** Filter mention candidates by case-insensitive containment, preferring prefix matches. */
export function filterAgentMentionCandidates(agents: AgentConfig[], query: string): AgentConfig[] {
	const normalizedQuery = query.toLowerCase();
	return agents
		.filter((agent) => agent.name.toLowerCase().includes(normalizedQuery))
		.sort((left, right) => {
			const leftName = left.name.toLowerCase();
			const rightName = right.name.toLowerCase();
			const leftStartsWith = leftName.startsWith(normalizedQuery);
			const rightStartsWith = rightName.startsWith(normalizedQuery);
			if (leftStartsWith !== rightStartsWith) return leftStartsWith ? -1 : 1;
			return leftName.localeCompare(rightName);
		})
		.slice(0, COMMAND_COMPLETION_LIMIT);
}

/** Replace exact, discovered `>agent` mentions with the main-LLM-friendly `subagent:agent` form. */
export function replaceAgentMentions(text: string, agents: AgentConfig[]): string {
	const mentionPattern = buildAgentMentionPattern(agents);
	if (!mentionPattern) return text;

	return text.replace(mentionPattern.pattern, (_match, boundary: string, name: string) => {
		const canonicalName = mentionPattern.canonicalNames.get(name.toLowerCase()) ?? name;
		return `${boundary}subagent:${canonicalName}`;
	});
}

/** Highlight only exact mentions for agents that are currently discoverable. */
export function highlightAgentMentions(
	text: string,
	agents: AgentConfig[],
	style: (mention: string) => string,
): string {
	const mentionPattern = buildAgentMentionPattern(agents);
	if (!mentionPattern) return text;

	return text.replace(mentionPattern.pattern, (_match, boundary: string, name: string) => {
		return `${boundary}${style(`>${name}`)}`;
	});
}

export function createAgentMentionHighlightEditor(
	baseEditor: EditorComponent,
	getAgents: () => AgentConfig[],
	theme: EditorTheme,
): EditorComponent {
	const highlightableEditor = baseEditor as HighlightableEditor;
	if (highlightableEditor[MENTION_HIGHLIGHT_WRAPPED]) return baseEditor;

	return new Proxy(highlightableEditor, {
		get(target, property) {
			if (property === MENTION_HIGHLIGHT_WRAPPED) return true;
			if (property === "render") {
				return (width: number) => {
					const agents = getAgents();
					return target
						.render(width)
						.map((line) => highlightAgentMentions(line, agents, (mention) => styleAgentMention(mention, theme)));
				};
			}

			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			return Reflect.set(target, property, value, target);
		},
	}) as EditorComponent;
}

export function registerAgentMentionHighlighting(ctx: ExtensionContext, getAgents: () => AgentConfig[]): void {
	if (ctx.mode !== "tui") return;

	const previousEditorFactory = ctx.ui.getEditorComponent();
	ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const baseEditor = previousEditorFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		return createAgentMentionHighlightEditor(baseEditor, getAgents, theme);
	});
}

export function createAgentMentionAutocompleteProvider(
	current: AutocompleteProvider,
	getAgents: () => AgentConfig[],
): AutocompleteProvider {
	return {
		triggerCharacters: Array.from(new Set([...(current.triggerCharacters ?? []), ">"])),
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const query = extractAgentMentionQuery(currentLine.slice(0, cursorCol));
			if (query === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const candidates = filterAgentMentionCandidates(getAgents(), query);
			if (options.signal.aborted || candidates.length === 0) return null;

			return {
				prefix: `>${query}`,
				items: candidates.map((agent) => ({
					value: `>${agent.name}`,
					label: `>${agent.name}`,
					description: agent.description,
				})),
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith(">")) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}

			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			// Append a trailing space so the mention hits its trailing boundary and converts,
			// but avoid doubling up when the cursor is already followed by whitespace.
			const suffix = /^\s/.test(afterCursor) ? "" : " ";
			const newLines = [...lines];
			newLines[cursorLine] = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + suffix.length,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
