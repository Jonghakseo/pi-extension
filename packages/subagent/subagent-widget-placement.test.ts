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
