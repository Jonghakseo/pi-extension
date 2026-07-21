import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents.ts";
import {
	createAgentMentionAutocompleteProvider,
	createAgentMentionHighlightEditor,
	extractAgentMentionQuery,
	filterAgentMentionCandidates,
	highlightAgentMentions,
	replaceAgentMentions,
} from "./mentions.ts";

function agent(name: string, description = `${name} description`): AgentConfig {
	return {
		name,
		description,
		source: "user",
		systemPrompt: "",
		filePath: `/agents/${name}.md`,
		runtime: "pi",
	};
}

const agents = [agent("worker"), agent("reviewer"), agent("security-auditor")];

describe("subagent prompt mentions", () => {
	it("extracts a mention query at the cursor without treating launch shortcuts as mentions", () => {
		expect(extractAgentMentionQuery("please ask >w")).toBe("w");
		expect(extractAgentMentionQuery("please ask (>review")).toBe("review");
		expect(extractAgentMentionQuery(">>")).toBeUndefined();
		expect(extractAgentMentionQuery("> worker")).toBeUndefined();
	});

	it("matches by containment and ranks prefix matches first", () => {
		expect(filterAgentMentionCandidates(agents, "w").map((candidate) => candidate.name)).toEqual([
			"worker",
			"reviewer",
		]);
		expect(filterAgentMentionCandidates(agents, "audit").map((candidate) => candidate.name)).toEqual([
			"security-auditor",
		]);
	});

	it("offers >agent completions and delegates unrelated input", async () => {
		const getSuggestions = vi.fn(async () => ({ items: [{ value: "fallback", label: "fallback" }], prefix: "x" }));
		const applyCompletion = vi.fn(() => ({ lines: ["done"], cursorLine: 0, cursorCol: 4 }));
		const current = {
			triggerCharacters: ["#"],
			getSuggestions,
			applyCompletion,
			shouldTriggerFileCompletion: vi.fn(() => false),
		};
		const provider = createAgentMentionAutocompleteProvider(current, () => agents);
		const signal = new AbortController().signal;
		const mentionText = "please ask >w";

		const suggestions = await provider.getSuggestions([mentionText], 0, mentionText.length, { signal });
		expect(provider.triggerCharacters).toEqual(["#", ">"]);
		expect(suggestions).toEqual({
			prefix: ">w",
			items: [
				{ value: ">worker", label: ">worker", description: "worker description" },
				{ value: ">reviewer", label: ">reviewer", description: "reviewer description" },
			],
		});
		expect(getSuggestions).not.toHaveBeenCalled();

		await provider.getSuggestions(["ordinary input"], 0, 14, { signal });
		expect(getSuggestions).toHaveBeenCalledOnce();

		const applied = provider.applyCompletion(
			[mentionText],
			0,
			mentionText.length,
			suggestions?.items[0] as never,
			">w",
		);
		expect(applyCompletion).not.toHaveBeenCalled();
		expect(applied).toEqual({ lines: ["please ask >worker "], cursorLine: 0, cursorCol: 19 });

		provider.applyCompletion(["unrelated"], 0, 9, { value: "x", label: "x" } as never, "#x");
		expect(applyCompletion).toHaveBeenCalledOnce();
	});

	it("does not double the trailing space when whitespace already follows", () => {
		const current = {
			triggerCharacters: ["#"],
			getSuggestions: vi.fn(),
			applyCompletion: vi.fn(),
		};
		const provider = createAgentMentionAutocompleteProvider(current, () => agents);
		const applied = provider.applyCompletion(
			["ask >w done"],
			0,
			6,
			{ value: ">worker", label: ">worker" } as never,
			">w",
		);
		expect(applied).toEqual({ lines: ["ask >worker done"], cursorLine: 0, cursorCol: 11 });
	});

	it("rewrites only exact discovered mentions for the main LLM", () => {
		expect(replaceAgentMentions("ask >Worker, then >reviewer. Keep >unknown.", agents)).toBe(
			"ask subagent:worker, then subagent:reviewer. Keep >unknown.",
		);
		expect(replaceAgentMentions(">worker handle this", agents)).toBe("subagent:worker handle this");
		expect(replaceAgentMentions(">> worker handle this", agents)).toBe(">> worker handle this");
		expect(replaceAgentMentions("> worker handle this", agents)).toBe("> worker handle this");
	});

	it("highlights only exact discovered mentions", () => {
		expect(highlightAgentMentions("ask >worker and >unknown", agents, (mention) => `[${mention}]`)).toBe(
			"ask [>worker] and >unknown",
		);
	});

	it("wraps an existing editor without replacing its behavior", () => {
		const baseEditor = {
			render: vi.fn(() => ["ask >worker and >unknown"]),
			invalidate: vi.fn(),
			getText: vi.fn(() => "ask >worker and >unknown"),
			setText: vi.fn(),
			handleInput: vi.fn(),
		};
		const theme = {
			borderColor: (text: string) => text,
			selectList: {
				selectedPrefix: (text: string) => text,
				selectedText: (text: string) => `<cyan>${text}</cyan>`,
				description: (text: string) => text,
				scrollInfo: (text: string) => text,
				noMatch: (text: string) => text,
			},
		};
		const editor = createAgentMentionHighlightEditor(baseEditor, () => agents, theme);

		expect(editor.render(80)).toEqual(["ask <cyan>>worker</cyan> and >unknown"]);
		editor.handleInput("x");
		expect(baseEditor.handleInput).toHaveBeenCalledWith("x");
		expect(createAgentMentionHighlightEditor(editor, () => agents, theme)).toBe(editor);
	});
});
