import { describe, expect, it, vi } from "vitest";
import { FINISHED_GROUP_TTL_MS, MAX_FINISHED_GROUPS } from "./constants.ts";
import {
	evictStaleFinishedGroups,
	formatCommandRunSummary,
	formatFinishedGroupStatus,
	removeRun,
	retireFinishedGroup,
} from "./run-utils.ts";
import { createStore } from "./store.ts";
import type { CommandRunState, FinishedGroupSnapshot } from "./types.ts";

function makeRun(overrides: Partial<CommandRunState> = {}): CommandRunState {
	return {
		id: 1,
		agent: "worker",
		task: "task",
		status: "running",
		startedAt: Date.now() - 1000,
		elapsedMs: 1000,
		toolCalls: 0,
		lastLine: "running",
		turnCount: 1,
		lastActivityAt: Date.now() - 1000,
		...overrides,
	};
}

function makeSnapshot(groupId: string, finishedAt = Date.now()): FinishedGroupSnapshot {
	return {
		groupId,
		kind: groupId.startsWith("b_") ? "batch" : "chain",
		terminalStatus: "completed",
		finishedAt,
		total: 1,
		failed: 0,
		aborted: 0,
		members: [{ summaryLine: "#1 [done] worker", output: "FULL_OUTPUT", task: "sample task" }],
	};
}

describe("subagent run observability", () => {
	it("renders aborted runs distinctly from generic errors", () => {
		const run = makeRun({ status: "error", errorClass: "aborted" });
		expect(formatCommandRunSummary(run)).toContain("#1 [aborted] worker");
	});

	it("terminalizes a running run when it is removed", () => {
		const store = createStore();
		const abortController = new AbortController();
		const run = makeRun({ abortController });
		store.commandRuns.set(run.id, run);
		store.globalLiveRuns.set(run.id, {
			runState: run,
			abortController,
			originSessionFile: "/tmp/main.jsonl",
		});

		const pi = { appendEntry: vi.fn() };
		const result = removeRun(store, run.id, { pi: pi as never, removalReason: "test-remove" });

		expect(result).toEqual({ removed: true, aborted: true });
		expect(abortController.signal.aborted).toBe(true);
		expect(run).toMatchObject({ removed: true, status: "error", errorClass: "aborted" });
		expect(formatCommandRunSummary(run)).toContain("#1 [aborted] worker");
		expect(pi.appendEntry).toHaveBeenCalledWith("subagent-removed", {
			runId: 1,
			reason: "test-remove",
			startedAt: run.startedAt,
			status: "aborted",
			errorClass: "aborted",
			stopReason: "aborted",
			message: "Aborting by remove...",
		});
	});
});

describe("finished subagent group retention", () => {
	it("retains only the most recent completed groups", () => {
		const store = createStore();
		for (let index = 0; index < MAX_FINISHED_GROUPS + 2; index++) {
			retireFinishedGroup(store, makeSnapshot(`b_${index}`));
		}

		expect(store.finishedGroups).toHaveLength(MAX_FINISHED_GROUPS);
		expect(store.finishedGroups.has("b_0")).toBe(false);
		expect(store.finishedGroups.has("b_1")).toBe(false);
		expect(store.finishedGroups.has(`b_${MAX_FINISHED_GROUPS + 1}`)).toBe(true);
	});

	it("evicts snapshots older than the retention TTL", () => {
		const store = createStore();
		const now = Date.now();
		retireFinishedGroup(store, makeSnapshot("b_stale", now - FINISHED_GROUP_TTL_MS - 1));
		retireFinishedGroup(store, makeSnapshot("b_fresh", now));

		expect(evictStaleFinishedGroups(store, now)).toBe(1);
		expect(store.finishedGroups.has("b_stale")).toBe(false);
		expect(store.finishedGroups.has("b_fresh")).toBe(true);
	});

	it("reports aborted members separately from failed members", () => {
		const snapshot = makeSnapshot("b_aborted");
		snapshot.terminalStatus = "aborted";
		snapshot.total = 2;
		snapshot.aborted = 1;
		snapshot.members = [
			{ summaryLine: "#1 [aborted] worker", output: "cancelled" },
			{ summaryLine: "#2 [done] reviewer", output: "done" },
		];

		const status = formatFinishedGroupStatus(snapshot, false);

		expect(status).toContain("[subagent-batch#b_aborted] aborted");
		expect(status).toContain("1 aborted");
		expect(status).not.toContain("failed");
	});

	it("shows member output only in detail mode", () => {
		const snapshot = makeSnapshot("p_finished");
		const status = formatFinishedGroupStatus(snapshot, false);
		const detail = formatFinishedGroupStatus(snapshot, true);

		expect(status).toContain("[subagent-chain#p_finished] completed");
		expect(status).not.toContain("FULL_OUTPUT");
		expect(detail).toContain("Task: sample task");
		expect(detail).toContain("FULL_OUTPUT");
	});
});
