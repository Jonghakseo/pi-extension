/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight session entry fixtures. */
import { describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "./commands.ts";
import { createStore } from "./store.ts";

function createCtx(entries: unknown[]) {
	return {
		cwd: "/tmp/project",
		mode: "json",
		hasUI: false,
		sessionManager: {
			getSessionFile: () => "/tmp/main.jsonl",
			getEntries: () => entries,
		},
		ui: {
			onTerminalInput: vi.fn(() => vi.fn()),
			addAutocompleteProvider: vi.fn(),
		},
	};
}

describe("subagent session restore observability", () => {
	it("derives aborted provenance from a legacy aborted terminal marker", () => {
		const store = createStore();
		const entries = [
			{
				type: "custom_message",
				customType: "subagent-command",
				content: "[subagent:worker#7] aborted\n\nSubagent execution was aborted.",
				details: {
					runId: 7,
					agent: "worker",
					task: "cancel task",
					status: "aborted",
					startedAt: Date.now() - 1000,
					elapsedMs: 1000,
				},
			},
		];

		handleSessionStart({} as never, store, createCtx(entries) as never);

		expect(store.commandRuns.get(7)).toMatchObject({ status: "error", errorClass: "aborted" });
	});

	it("does not infer aborted from a successful output body that quotes an aborted marker", () => {
		const store = createStore();
		const entries = [
			{
				type: "custom_message",
				customType: "subagent-command",
				content: "[subagent:worker#9] completed\n\nInvestigated the text [subagent:worker#1] aborted in a log.",
				details: {
					runId: 9,
					agent: "worker",
					task: "inspect log",
					status: "done",
					exitCode: 0,
					startedAt: Date.now() - 1000,
					elapsedMs: 1000,
				},
			},
		];

		handleSessionStart({} as never, store, createCtx(entries) as never);

		expect(store.commandRuns.get(9)).toMatchObject({ status: "done" });
		expect(store.commandRuns.get(9)?.errorClass).not.toBe("aborted");
	});

	it("restores a removed running run as aborted from removal metadata", () => {
		const store = createStore();
		const startedAt = Date.now() - 1000;
		const entries = [
			{
				type: "custom_message",
				customType: "subagent-command",
				content: "[subagent:worker#8] started",
				details: {
					runId: 8,
					agent: "worker",
					task: "remove task",
					status: "started",
					startedAt,
				},
			},
			{
				type: "custom",
				customType: "subagent-removed",
				data: {
					runId: 8,
					startedAt,
					status: "aborted",
					errorClass: "aborted",
					stopReason: "aborted",
					message: "Aborting by remove...",
				},
			},
		];

		handleSessionStart({} as never, store, createCtx(entries) as never);

		expect(store.commandRuns.get(8)).toMatchObject({
			status: "error",
			errorClass: "aborted",
			removed: true,
			lastLine: "Aborting by remove...",
		});
	});

	it("does not reapply old removal metadata to a later successful continuation", () => {
		const store = createStore();
		const firstStartedAt = Date.now() - 2000;
		const continuedAt = Date.now() - 1000;
		const entries = [
			{
				type: "custom_message",
				customType: "subagent-command",
				content: "[subagent:worker#10] started",
				details: { runId: 10, agent: "worker", task: "first", status: "started", startedAt: firstStartedAt },
			},
			{
				type: "custom",
				customType: "subagent-removed",
				data: {
					runId: 10,
					startedAt: firstStartedAt,
					status: "aborted",
					errorClass: "aborted",
					stopReason: "aborted",
				},
			},
			{
				type: "custom_message",
				customType: "subagent-command",
				content: "[subagent:worker#10] completed\n\ncontinued successfully",
				details: {
					runId: 10,
					agent: "worker",
					task: "continue",
					status: "done",
					exitCode: 0,
					startedAt: continuedAt,
				},
			},
		];

		handleSessionStart({} as never, store, createCtx(entries) as never);

		expect(store.commandRuns.get(10)).toMatchObject({ status: "done", startedAt: continuedAt });
		expect(store.commandRuns.get(10)?.removed).not.toBe(true);
		expect(store.commandRuns.get(10)?.errorClass).not.toBe("aborted");
	});
});
