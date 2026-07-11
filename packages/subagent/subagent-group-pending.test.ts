import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = path.join(process.cwd(), ".tmp-subagent-group-pending-tests");

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return {
		...actual,
		homedir: () => testHome,
	};
});

async function loadModule() {
	vi.resetModules();
	return await import("./group-pending.ts");
}

describe("group-pending durable storage", () => {
	beforeEach(() => {
		fs.rmSync(testHome, { recursive: true, force: true });
	});

	afterEach(() => {
		fs.rmSync(testHome, { recursive: true, force: true });
	});

	it("upserts and consumes pending group completions by origin session", async () => {
		const mod = await loadModule();
		const pendingCompletion = {
			message: {
				customType: "subagent-tool",
				content: "batch summary",
				display: true,
				details: { batchId: "b_1" },
			},
			options: { deliverAs: "followUp" as const, triggerTurn: true },
			createdAt: 100,
		};

		mod.upsertPendingGroupCompletion({
			scope: "batch",
			groupId: "b_1",
			originSessionFile: "/tmp/origin-a.jsonl",
			runIds: [1, 2],
			pendingCompletion,
		});
		mod.upsertPendingGroupCompletion({
			scope: "chain",
			groupId: "p_1",
			originSessionFile: "/tmp/origin-b.jsonl",
			runIds: [3, 4],
			pendingCompletion: {
				...pendingCompletion,
				message: { ...pendingCompletion.message, content: "chain summary" },
			},
		});

		const consumed = mod.consumePendingGroupCompletionsForSession("/tmp/origin-a.jsonl");
		expect(consumed).toHaveLength(1);
		expect(consumed[0]?.groupId).toBe("b_1");
		expect(consumed[0]?.pendingCompletion.message.content).toBe("batch summary");

		const secondPass = mod.consumePendingGroupCompletionsForSession("/tmp/origin-a.jsonl");
		expect(secondPass).toEqual([]);

		const otherSession = mod.consumePendingGroupCompletionsForSession("/tmp/origin-b.jsonl");
		expect(otherSession).toHaveLength(1);
		expect(otherSession[0]?.groupId).toBe("p_1");
	});

	it("evicts stale entries based on pending completion createdAt", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T12:00:00Z"));
		const mod = await loadModule();

		mod.upsertPendingGroupCompletion({
			scope: "batch",
			groupId: "old-batch",
			originSessionFile: "/tmp/origin-old.jsonl",
			runIds: [1],
			pendingCompletion: {
				message: {
					customType: "subagent-tool",
					content: "old",
					display: true,
					details: {},
				},
				options: { deliverAs: "followUp", triggerTurn: true },
				createdAt: Date.now() - 31 * 60 * 1000,
			},
		});
		mod.upsertPendingGroupCompletion({
			scope: "chain",
			groupId: "fresh-chain",
			originSessionFile: "/tmp/origin-fresh.jsonl",
			runIds: [2],
			pendingCompletion: {
				message: {
					customType: "subagent-tool",
					content: "fresh",
					display: true,
					details: {},
				},
				options: { deliverAs: "followUp", triggerTurn: true },
				createdAt: Date.now() - 5 * 60 * 1000,
			},
		});

		mod.evictStalePendingGroupCompletions(30 * 60 * 1000);

		expect(mod.consumePendingGroupCompletionsForSession("/tmp/origin-old.jsonl")).toEqual([]);
		const fresh = mod.consumePendingGroupCompletionsForSession("/tmp/origin-fresh.jsonl");
		expect(fresh).toHaveLength(1);
		expect(fresh[0]?.groupId).toBe("fresh-chain");

		vi.useRealTimers();
	});
});
