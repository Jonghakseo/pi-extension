import { describe, expect, it } from "vitest";
import { createStore } from "./store.ts";
import type { CommandRunState } from "./types.ts";
import { updateCommandRunsWidget } from "./widget.ts";

function makeRun(overrides: Partial<CommandRunState> = {}): CommandRunState {
	return {
		id: 1,
		agent: "worker",
		task: "test task",
		status: "done",
		startedAt: Date.now() - 1000,
		elapsedMs: 1000,
		toolCalls: 0,
		lastLine: "done",
		turnCount: 1,
		lastActivityAt: Date.now() - 500,
		...overrides,
	};
}

describe("subagent run status widget placement", () => {
	it("renders run status widgets above the editor", () => {
		const store = createStore();
		store.commandRuns.set(1, makeRun());
		const calls: Array<{ key: string; options?: { placement?: string } }> = [];

		updateCommandRunsWidget(store, {
			hasUI: true,
			ui: {
				setWidget: (key: string, _content: unknown, options?: { placement?: string }) => {
					calls.push({ key, options });
				},
			},
		});

		expect(calls).toContainEqual({ key: "sub-1", options: { placement: "aboveEditor" } });
		expect(calls).not.toContainEqual({ key: "sub-1", options: { placement: "belowEditor" } });
	});

	it("shows the context usage percentage beside the compact bar", () => {
		const store = createStore();
		store.commandRuns.set(
			1,
			makeRun({
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50_000, turns: 1 },
				model: "test-model",
			}),
		);
		let factory:
			| ((
					tui: unknown,
					theme: {
						fg: (color: string, text: string) => string;
						bold: (text: string) => string;
						bg: (color: string, text: string) => string;
					},
			  ) => { render: (width: number) => string[] })
			| undefined;

		updateCommandRunsWidget(store, {
			hasUI: true,
			modelRegistry: { getAll: () => [{ provider: "test", id: "test-model", contextWindow: 100_000 }] },
			ui: {
				setWidget: (key: string, content: unknown) => {
					if (key === "sub-1" && typeof content === "function") factory = content as typeof factory;
				},
			},
		});

		const widget = factory?.({}, { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text });
		expect(widget?.render(100).join("\n")).toContain("50%");
	});

	it("renders the parent session hint above the editor", () => {
		const store = createStore();
		store.currentParentSessionFile = "/tmp/parent.jsonl";
		const calls: Array<{ key: string; options?: { placement?: string } }> = [];

		updateCommandRunsWidget(store, {
			hasUI: true,
			ui: {
				setWidget: (key: string, _content: unknown, options?: { placement?: string }) => {
					calls.push({ key, options });
				},
			},
		});

		expect(calls).toContainEqual({ key: "sub-parent", options: { placement: "aboveEditor" } });
		expect(calls).not.toContainEqual({ key: "sub-parent", options: { placement: "belowEditor" } });
	});
});
