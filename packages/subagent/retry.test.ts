import { describe, expect, it } from "vitest";
import { diagnoseRetryableResult } from "./retry.ts";
import type { SingleResult } from "./types.ts";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "project",
		task: "task",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		stopReason: "error",
		...overrides,
	};
}

describe("diagnoseRetryableResult", () => {
	it.each(["WebSocket error", "Connection error."])("retries transient network failure: %s", (errorMessage) => {
		expect(diagnoseRetryableResult(makeResult({ errorMessage })).retryable).toBe(true);
	});

	it("retries an exact terminated error message", () => {
		expect(diagnoseRetryableResult(makeResult({ errorMessage: " Terminated. " })).retryable).toBe(true);
	});

	it("does not retry a runner signal termination diagnostic", () => {
		expect(
			diagnoseRetryableResult(
				makeResult({ errorMessage: undefined, stderr: "[runner] process terminated by signal 15" }),
			).retryable,
		).toBe(false);
	});

	it("does not retry an aborted result", () => {
		expect(
			diagnoseRetryableResult(makeResult({ stopReason: "aborted", errorMessage: "WebSocket error" })).retryable,
		).toBe(false);
	});
});
