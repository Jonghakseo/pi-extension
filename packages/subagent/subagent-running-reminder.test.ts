/** biome-ignore-all lint/suspicious/noExplicitAny: minimal run-state fixtures. */
import { describe, expect, it } from "vitest";
import { handleRunningReminderContext, ReminderAnchors } from "./running-reminder.js";

function storeWith(...runs: Array<Record<string, unknown>>) {
	const globalLiveRuns = new Map<number, any>();
	const batchGroups = new Map<string, any>();
	const pipelines = new Map<string, any>();
	for (const run of runs) {
		const { originSessionFile = "/s/main.jsonl", pendingCompletion, liveBatch, livePipeline, ...state } = run;
		globalLiveRuns.set(state.id as number, {
			runState: { agent: "worker", task: "task", status: "running", startedAt: 0, ...state },
			abortController: new AbortController(),
			originSessionFile,
			pendingCompletion,
		});
		if (liveBatch) batchGroups.set(state.batchId as string, { batchId: state.batchId });
		if (livePipeline) pipelines.set(state.pipelineId as string, { pipelineId: state.pipelineId });
	}
	return { globalLiveRuns, batchGroups, pipelines };
}

const messages = [{ role: "user", content: "hi", timestamp: 1 }];
const assistantCall = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call", name: "subagent" }],
	timestamp: 2,
};
const toolResult = {
	role: "toolResult",
	toolCallId: "call",
	toolName: "subagent",
	content: [{ type: "text", text: "started" }],
	isError: false,
	timestamp: 3,
};

function reminderOf(result: any): string {
	return result.messages.at(-1).content as string;
}

describe("subagent still-running reminder", () => {
	it("skips runs whose results never go to the model", () => {
		const anchors = new ReminderAnchors();
		const store = storeWith({ id: 1, deliveryMode: "humanOnly" }, { id: 2, removed: true });
		expect(handleRunningReminderContext(anchors, messages, store, "/s/main.jsonl", 5_000)).toBeUndefined();
	});

	it("keeps a finished run listed while its delivery is still owed", () => {
		// Batch and chain members stay live until the group summary goes out.
		const anchors = new ReminderAnchors();
		const store = storeWith(
			{ id: 5, task: "audit deps", status: "done", batchId: "b_1", liveBatch: true },
			{ id: 6, task: "run lint", status: "error", batchId: "b_1", liveBatch: true },
			{ id: 7, task: "write docs", startedAt: 1_000, batchId: "b_1", liveBatch: true },
			{ id: 8, task: "ship notes", status: "done", pendingCompletion: { message: {} } },
		);
		const result = handleRunningReminderContext(anchors, messages, store, "/s/main.jsonl", 11_000) as any;
		const reminder = reminderOf(result);
		expect(reminder).toContain('subagent run #5 worker "audit deps" finished, result not delivered yet');
		expect(reminder).toContain('subagent run #6 worker "run lint" finished, result not delivered yet');
		expect(reminder).toContain('subagent run #7 worker "write docs" 10s');
		expect(reminder).toContain('subagent run #8 worker "ship notes" finished, result not delivered yet');
	});

	it("drops a finished run whose group and held completion are both gone", () => {
		const anchors = new ReminderAnchors();
		const store = storeWith(
			{ id: 9, task: "stale batch member", status: "done", batchId: "b_gone" },
			{ id: 10, task: "stale chain step", status: "error", pipelineId: "p_gone" },
		);
		expect(handleRunningReminderContext(anchors, messages, store, "/s/main.jsonl", 5_000)).toBeUndefined();
	});

	it("keeps a finished chain step listed while its pipeline is alive", () => {
		const anchors = new ReminderAnchors();
		const store = storeWith({ id: 11, task: "build", status: "done", pipelineId: "p_1", livePipeline: true });
		const result = handleRunningReminderContext(anchors, messages, store, "/s/main.jsonl", 5_000) as any;
		expect(reminderOf(result)).toContain('subagent run #11 worker "build" finished, result not delivered yet');
	});

	it("lists running runs with id, agent, task, and elapsed time", () => {
		const anchors = new ReminderAnchors();
		const store = storeWith({ id: 19, task: "fix the flaky test", startedAt: 1_000 });
		const result = handleRunningReminderContext(anchors, messages, store, "/s/main.jsonl", 131_000) as any;
		expect(result.messages).toHaveLength(2);
		expect(result.messages[1].content).toContain('subagent run #19 worker "fix the flaky test" 2m 10s');
		expect(messages).toHaveLength(1);
	});

	it("warns inside the tool loop that started the run and repeats the reminder verbatim", () => {
		const anchors = new ReminderAnchors();
		const empty = { globalLiveRuns: new Map(), batchGroups: new Map(), pipelines: new Map() };
		// The turn opens with no run at all, so nothing is injected yet.
		expect(handleRunningReminderContext(anchors, messages, empty, "/s/main.jsonl", 1_000)).toBeUndefined();

		const store = storeWith({ id: 19, task: "fix the flaky test", startedAt: 1_000 });
		const afterStart = [...messages, assistantCall, toolResult];
		const first = handleRunningReminderContext(anchors, afterStart, store, "/s/main.jsonl", 6_000) as any;
		expect(first.messages).toHaveLength(4);
		expect(reminderOf(first)).toContain('subagent run #19 worker "fix the flaky test" 5s');

		const nextCall = { ...assistantCall, timestamp: 4 };
		const nextResult = { ...toolResult, toolCallId: "call2", timestamp: 5 };
		const second = handleRunningReminderContext(
			anchors,
			[...afterStart, nextCall, nextResult],
			store,
			"/s/main.jsonl",
			60_000,
		) as any;
		// Same text at the same place: the request only grows past the cached prefix.
		expect(second.messages.slice(0, 4)).toEqual(first.messages);
		expect(second.messages).toHaveLength(6);
	});

	it("adds a fresh reminder when a new turn starts and keeps the earlier one in place", () => {
		const anchors = new ReminderAnchors();
		const store = storeWith({ id: 19, task: "fix the flaky test", startedAt: 1_000 });
		const first = handleRunningReminderContext(anchors, messages, store, "/s/main.jsonl", 6_000) as any;
		const nextTurn = [...messages, { role: "user", content: "any news?", timestamp: 9 }];
		const second = handleRunningReminderContext(anchors, nextTurn, store, "/s/main.jsonl", 66_000) as any;
		expect(second.messages.slice(0, 2)).toEqual(first.messages);
		expect(second.messages).toHaveLength(4);
		expect(reminderOf(second)).toContain('subagent run #19 worker "fix the flaky test" 1m 5s');
	});

	it("does not anchor again mid-turn when the pending set only shrank", () => {
		const anchors = new ReminderAnchors();
		const store = storeWith(
			{ id: 20, task: "lint", startedAt: 1_000 },
			{ id: 21, task: "typecheck", startedAt: 1_000 },
		);
		const first = handleRunningReminderContext(
			anchors,
			[...messages, toolResult],
			store,
			"/s/main.jsonl",
			6_000,
		) as any;
		expect(reminderOf(first)).toContain("#21");

		store.globalLiveRuns.delete(21);
		const later = [...messages, toolResult, { ...assistantCall, timestamp: 7 }, { ...toolResult, timestamp: 8 }];
		const second = handleRunningReminderContext(anchors, later, store, "/s/main.jsonl", 9_000) as any;
		expect(second.messages.filter((message: any) => message.role === "custom")).toHaveLength(1);
		expect(second.messages.slice(0, 3)).toEqual(first.messages);
	});

	it("ignores runs started by another session", () => {
		const anchors = new ReminderAnchors();
		const store = storeWith({ id: 22, task: "other session work", originSessionFile: "/s/other.jsonl" });
		expect(handleRunningReminderContext(anchors, messages, store, "/s/main.jsonl", 5_000)).toBeUndefined();
	});
});
