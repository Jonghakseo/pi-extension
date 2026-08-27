import { describe, expect, it } from "vitest";
import { classifySubagentFailure, countTextChars } from "./failure-telemetry.ts";

describe("classifySubagentFailure", () => {
	it("classifies context overflow before generic process failures", () => {
		expect(
			classifySubagentFailure({
				failed: true,
				exitCode: 1,
				errorMessage: "Your input exceeds the context window of this model.",
			}),
		).toBe("context_overflow");
	});

	it("distinguishes overloaded and rate-limit provider errors", () => {
		expect(
			classifySubagentFailure({
				failed: true,
				stopReason: "error",
				errorMessage: "Codex error: Our servers are currently overloaded. Please try again later.",
			}),
		).toBe("overloaded");
		expect(classifySubagentFailure({ failed: true, stopReason: "error", errorMessage: "429 too many requests" })).toBe(
			"rate_limit",
		);
	});

	it("classifies transient network failures", () => {
		for (const errorMessage of ["WebSocket error", "Connection error.", " Terminated. "]) {
			expect(classifySubagentFailure({ failed: true, exitCode: 1, errorMessage })).toBe("network_error");
		}
	});

	it.each([
		undefined,
		"WebSocket error",
		"Terminated.",
	])("does not classify a runner signal termination diagnostic with errorMessage %s as a network error", (errorMessage) => {
		expect(
			classifySubagentFailure({
				failed: true,
				exitCode: 143,
				errorMessage,
				stderr: "[runner] process terminated by signal 15",
			}),
		).toBe("process_error");
	});

	it("classifies tool, aborted, process, and unknown failures", () => {
		expect(
			classifySubagentFailure({
				failed: true,
				stopReason: "error",
				errorMessage: "Tool execution failed: WebSocket error",
			}),
		).toBe("tool_error");
		expect(classifySubagentFailure({ failed: true, stopReason: "aborted" })).toBe("aborted");
		expect(classifySubagentFailure({ failed: true, exitCode: 2 })).toBe("process_error");
		expect(classifySubagentFailure({ failed: true, stopReason: "error", errorMessage: "unexpected" })).toBe("unknown");
		expect(classifySubagentFailure({ failed: false, errorMessage: "rate limit" })).toBeUndefined();
	});
});

describe("countTextChars", () => {
	it("counts nested textual tool-result content", () => {
		expect(
			countTextChars([
				{ type: "text", text: "hello" },
				{ type: "tool_result", content: "world" },
				{ type: "tool_result", content: [{ type: "text", text: "!" }] },
			]),
		).toBe(11);
	});
});
