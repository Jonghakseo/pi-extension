import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createRunDiagnosticSink,
	RUNNER_DIAGNOSTIC_CUSTOM_TYPE,
	RUNNER_DIAGNOSTIC_SCHEMA_VERSION,
} from "./diagnostics.ts";
import type { CommandRunState } from "./types.ts";

function makeRun(): CommandRunState {
	return {
		id: 7,
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
		pipelineStepIndex: 2,
	};
}

describe("subagent runner diagnostics", () => {
	it("persists diagnostics as non-message custom entries without task text", () => {
		const appendEntry = vi.fn();
		const sink = createRunDiagnosticSink({ appendEntry } as never, makeRun());

		sink({
			event: "exit",
			runtime: "pi",
			childPid: 4321,
			code: null,
			signal: "SIGTERM",
		});

		expect(appendEntry).toHaveBeenCalledTimes(1);
		const [customType, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(customType).toBe(RUNNER_DIAGNOSTIC_CUSTOM_TYPE);
		expect(data).toMatchObject({
			schemaVersion: RUNNER_DIAGNOSTIC_SCHEMA_VERSION,
			runId: 7,
			agent: "worker",
			batchId: "b_test",
			pipelineStepIndex: 2,
			event: "exit",
			runtime: "pi",
			childPid: 4321,
			code: null,
			signal: "SIGTERM",
		});
		expect(data).not.toHaveProperty("task");
	});

	it("does not project custom diagnostic entries into LLM context", () => {
		const messages = sessionEntryToContextMessages({
			type: "custom",
			id: "diag-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: RUNNER_DIAGNOSTIC_CUSTOM_TYPE,
			data: { event: "process_error", error: { stack: "hidden stack trace" } },
		});

		expect(messages).toEqual([]);
	});
});
