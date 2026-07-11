import { describe, expect, it } from "vitest";
import { diagnoseResultFailure } from "./tool-execute.ts";
import type { SingleResult } from "./types.ts";

function makeResult(partial: Partial<SingleResult>): SingleResult {
	return {
		agent: "worker",
		agentSource: "project",
		task: "task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...partial,
	};
}

describe("diagnoseResultFailure", () => {
	it("fails when subagent returns no messages and no output", () => {
		const result = makeResult({ messages: [], stderr: "" });
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(true);
		expect(diagnosis.reason).toContain("no messages");
	});

	it("includes stderr diagnostics in no-message failure reason", () => {
		const result = makeResult({
			messages: [],
			stderr: "[runner] no assistant/tool messages captured; settleReason=close; exitCode=0",
		});
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(true);
		expect(diagnosis.reason).toContain("stderr:");
		expect(diagnosis.reason).toContain("settleReason=close");
	});

	it("fails with explicit exit code reason", () => {
		const result = makeResult({ exitCode: 2 });
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(true);
		expect(diagnosis.reason).toContain("code 2");
	});

	it("fails when stopReason is error", () => {
		const result = makeResult({ stopReason: "error", errorMessage: "rate limited" });
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(true);
		expect(diagnosis.reason).toContain("rate limited");
	});

	it("classifies codex context-overflow error as contextOverflow", () => {
		const result = makeResult({
			stopReason: "error",
			errorMessage:
				"Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 263963, turns: 44 },
		});
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(true);
		expect(diagnosis.contextOverflow).toBe(true);
		expect(diagnosis.reason).toContain("44 turn");
		expect(diagnosis.reason).toContain("context window");
	});

	it("classifies proactive context-guard stop as contextOverflow", () => {
		const result = makeResult({
			stopReason: "error",
			errorMessage: "context guard: stopped at 235100 tokens (ceiling 235000) to preserve partial findings.",
		});
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.contextOverflow).toBe(true);
	});

	it("does not misclassify rate-limit error as context overflow", () => {
		const result = makeResult({ stopReason: "error", errorMessage: "rate limited" });
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.contextOverflow).toBeFalsy();
		expect(diagnosis.reason).toContain("rate limited");
	});

	it("fails when stopReason is aborted", () => {
		const result = makeResult({ stopReason: "aborted" });
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(true);
		expect(diagnosis.reason).toContain("aborted");
	});

	it("fails when messages exist but assistant text is empty", () => {
		const result = makeResult({
			messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] } as never],
			stderr: "diag",
		});
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(true);
		expect(diagnosis.reason).toContain("without assistant text output");
		expect(diagnosis.reason).toContain("diag");
	});

	it("passes when assistant text exists", () => {
		const result = makeResult({
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] } as never],
		});
		const diagnosis = diagnoseResultFailure(result);
		expect(diagnosis.failed).toBe(false);
	});
});
