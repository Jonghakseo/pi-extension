import { describe, expect, it } from "vitest";
import { FINISHED_GROUP_TTL_MS, MAX_FINISHED_GROUPS } from "./constants.ts";
import { evictStaleFinishedGroups, formatFinishedGroupStatus, retireFinishedGroup } from "./run-utils.ts";
import { createStore } from "./store.ts";
import type { FinishedGroupSnapshot } from "./types.ts";

function makeSnapshot(groupId: string, finishedAt = Date.now()): FinishedGroupSnapshot {
	return {
		groupId,
		kind: groupId.startsWith("b_") ? "batch" : "chain",
		terminalStatus: "completed",
		finishedAt,
		total: 1,
		failed: 0,
		members: [{ summaryLine: "#1 [done] worker", output: "FULL_OUTPUT", task: "sample task" }],
	};
}

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
