import { describe, expect, it, vi } from "vitest";
import {
	ACTIVITY_LAST_LINE_MAX_CHARS,
	ACTIVITY_MIN_INTERVAL_MS,
	type ActivitySnapshot,
	createActivityThrottleState,
	createRunActivityRecorder,
	evaluateActivityEmission,
	normalizeActivityLine,
	SUBAGENT_ACTIVITY_CUSTOM_TYPE,
	SUBAGENT_ACTIVITY_SCHEMA_VERSION,
} from "./activity.ts";
import type { CommandRunState } from "./types.ts";

function makeSnapshot(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
	return {
		status: "running",
		runId: 3,
		agent: "worker",
		toolCallCount: 1,
		lastToolName: "read",
		lastLine: "reading file",
		...overrides,
	};
}

describe("evaluateActivityEmission", () => {
	it("emits on first tool activity", () => {
		const state = createActivityThrottleState();
		const payload = evaluateActivityEmission(state, makeSnapshot(), 10_000);
		expect(payload).toEqual({
			runId: 3,
			agent: "worker",
			toolCallCount: 1,
			lastToolName: "read",
			lastLine: "reading file",
		});
	});

	it("does not emit before any tool activity", () => {
		const state = createActivityThrottleState();
		const payload = evaluateActivityEmission(
			state,
			makeSnapshot({ toolCallCount: 0, lastToolName: undefined }),
			10_000,
		);
		expect(payload).toBeNull();
	});

	it("does not emit a stale lastToolName when the tool count is zero (continuation reset)", () => {
		const state = createActivityThrottleState();
		const payload = evaluateActivityEmission(state, makeSnapshot({ toolCallCount: 0, lastToolName: "read" }), 10_000);
		expect(payload).toBeNull();
	});

	it("does not emit when nothing changed", () => {
		const state = createActivityThrottleState();
		expect(evaluateActivityEmission(state, makeSnapshot(), 10_000)).not.toBeNull();
		expect(evaluateActivityEmission(state, makeSnapshot({ lastLine: "different line only" }), 20_000)).toBeNull();
	});

	it("suppresses changes within the minimum interval and emits after it passes", () => {
		const state = createActivityThrottleState();
		expect(evaluateActivityEmission(state, makeSnapshot(), 10_000)).not.toBeNull();

		const changed = makeSnapshot({ toolCallCount: 2, lastToolName: "edit" });
		expect(evaluateActivityEmission(state, changed, 10_000 + ACTIVITY_MIN_INTERVAL_MS - 1)).toBeNull();

		const emitted = evaluateActivityEmission(state, changed, 10_000 + ACTIVITY_MIN_INTERVAL_MS);
		expect(emitted).toMatchObject({ toolCallCount: 2, lastToolName: "edit" });
	});

	it("keeps a suppressed change pending until a later evaluation", () => {
		const state = createActivityThrottleState();
		expect(evaluateActivityEmission(state, makeSnapshot(), 10_000)).not.toBeNull();
		const changed = makeSnapshot({ toolCallCount: 2 });
		expect(evaluateActivityEmission(state, changed, 11_000)).toBeNull();
		expect(evaluateActivityEmission(state, changed, 60_000)).toMatchObject({ toolCallCount: 2 });
	});

	it("does not emit for non-running statuses", () => {
		for (const status of ["done", "error"] as const) {
			const state = createActivityThrottleState();
			expect(evaluateActivityEmission(state, makeSnapshot({ status }), 10_000)).toBeNull();
		}
	});

	it("includes optional grouping fields only when present", () => {
		const state = createActivityThrottleState();
		const payload = evaluateActivityEmission(
			state,
			makeSnapshot({ batchId: "b_1", pipelineId: "p_1", pipelineStepIndex: 0, contextTokens: 84_000 }),
			10_000,
		);
		expect(payload).toMatchObject({ batchId: "b_1", pipelineId: "p_1", pipelineStepIndex: 0, contextTokens: 84_000 });

		const bare = evaluateActivityEmission(createActivityThrottleState(), makeSnapshot({ lastLine: undefined }), 10_000);
		expect(bare).not.toBeNull();
		expect(Object.keys(bare ?? {})).toEqual(["runId", "agent", "toolCallCount", "lastToolName"]);
	});
});

describe("normalizeActivityLine", () => {
	it("strips ANSI sequences", () => {
		expect(normalizeActivityLine("\u001b[32mdone\u001b[0m in 2s")).toBe("done in 2s");
	});

	it("collapses multi-line text to the last non-empty line", () => {
		expect(normalizeActivityLine("first\n\n  second  \n\n")).toBe("second");
	});

	it("treats carriage returns as line boundaries", () => {
		expect(normalizeActivityLine("progress 10%\rprogress 90%")).toBe("progress 90%");
		expect(normalizeActivityLine("first\r\nsecond")).toBe("second");
	});

	it("caps length at the max chars", () => {
		const long = "x".repeat(ACTIVITY_LAST_LINE_MAX_CHARS + 50);
		expect(normalizeActivityLine(long)).toHaveLength(ACTIVITY_LAST_LINE_MAX_CHARS);
	});

	it("returns undefined for empty or whitespace-only input", () => {
		expect(normalizeActivityLine(undefined)).toBeUndefined();
		expect(normalizeActivityLine("   \n  ")).toBeUndefined();
	});
});

describe("createRunActivityRecorder", () => {
	function makeRun(): CommandRunState {
		return {
			id: 3,
			agent: "worker",
			task: "sensitive task text",
			status: "running",
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			elapsedMs: 0,
			toolCalls: 0,
			lastLine: "",
			turnCount: 1,
			batchId: "b_test",
		};
	}

	it("appends a schema-versioned subagent-activity entry without task text", () => {
		const appendEntry = vi.fn();
		const run = makeRun();
		const record = createRunActivityRecorder({ appendEntry } as never, run);

		record();
		expect(appendEntry).not.toHaveBeenCalled();

		run.toolCalls = 1;
		run.lastToolName = "edit";
		run.lastLine = "edited runner.ts";
		record();

		expect(appendEntry).toHaveBeenCalledTimes(1);
		const [customType, data] = appendEntry.mock.calls[0];
		expect(customType).toBe(SUBAGENT_ACTIVITY_CUSTOM_TYPE);
		expect(data).toMatchObject({
			schemaVersion: SUBAGENT_ACTIVITY_SCHEMA_VERSION,
			runId: 3,
			agent: "worker",
			batchId: "b_test",
			lastToolName: "edit",
			toolCallCount: 1,
			lastLine: "edited runner.ts",
		});
		expect(typeof data.recordedAt).toBe("string");
		expect(JSON.stringify(data)).not.toContain("sensitive task text");
	});

	it("stops emitting once the run leaves running state", () => {
		const appendEntry = vi.fn();
		const run = makeRun();
		const record = createRunActivityRecorder({ appendEntry } as never, run);
		run.toolCalls = 1;
		run.lastToolName = "read";
		record();
		expect(appendEntry).toHaveBeenCalledTimes(1);

		run.status = "done";
		run.toolCalls = 2;
		record();
		expect(appendEntry).toHaveBeenCalledTimes(1);
	});

	it("swallows appendEntry failures", () => {
		const appendEntry = vi.fn(() => {
			throw new Error("session torn down");
		});
		const run = makeRun();
		run.toolCalls = 1;
		run.lastToolName = "read";
		const record = createRunActivityRecorder({ appendEntry } as never, run);
		expect(() => record()).not.toThrow();
	});
});
