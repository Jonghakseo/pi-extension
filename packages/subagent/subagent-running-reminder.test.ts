/** biome-ignore-all lint/suspicious/noExplicitAny: minimal run-state fixtures. */
import { describe, expect, it } from "vitest";
import { handleRunningReminderContext } from "./running-reminder.js";

function storeWith(...runs: Array<Record<string, unknown>>) {
	const globalLiveRuns = new Map<number, any>();
	for (const run of runs) {
		const { originSessionFile = "/s/main.jsonl", ...state } = run;
		globalLiveRuns.set(state.id as number, {
			runState: { agent: "worker", task: "task", status: "running", startedAt: 0, ...state },
			abortController: new AbortController(),
			originSessionFile,
		});
	}
	return { globalLiveRuns };
}

const messages = [{ role: "user", content: "hi", timestamp: 1 }];

describe("subagent still-running reminder", () => {
	it("skips runs whose results never go to the model or that already settled", () => {
		const store = storeWith(
			{ id: 1, deliveryMode: "humanOnly" },
			{ id: 2, removed: true },
			{ id: 3, status: "done" },
			{ id: 4, status: "error" },
		);
		expect(handleRunningReminderContext(messages, store, "/s/main.jsonl", 5_000)).toBeUndefined();
	});

	it("lists running runs with id, agent, task, and elapsed time", () => {
		const store = storeWith({ id: 19, task: "fix the flaky test", startedAt: 1_000 });
		const result = handleRunningReminderContext(messages, store, "/s/main.jsonl", 131_000) as any;
		expect(result.messages).toHaveLength(2);
		expect(result.messages[1].content).toContain('subagent run #19 worker "fix the flaky test" 2m 10s');
		expect(messages).toHaveLength(1);
	});
});
