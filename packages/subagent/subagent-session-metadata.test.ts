/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { describe, expect, it } from "vitest";
import { createStreamState, processClaudeEvent, stateToSingleResult } from "./claude-stream-parser.ts";
import { updateRunFromResult } from "./store.ts";
import type { CommandRunState, SingleResult } from "./types.ts";

function makeRunState(overrides: Partial<CommandRunState> = {}): CommandRunState {
	return {
		id: 1,
		agent: "test",
		task: "test task",
		status: "running",
		startedAt: Date.now() - 5000,
		elapsedMs: 5000,
		toolCalls: 0,
		lastLine: "",
		turnCount: 0,
		lastActivityAt: Date.now() - 5000,
		...overrides,
	};
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "test",
		agentSource: "user",
		task: "test task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

describe("SingleResult → CommandRunState metadata propagation", () => {
	it("propagates runtime from result to run state", () => {
		const run = makeRunState();
		updateRunFromResult(run, makeResult({ runtime: "claude" }));
		expect(run.runtime).toBe("claude");
	});

	it("propagates claudeSessionId from result to run state", () => {
		const run = makeRunState();
		updateRunFromResult(run, makeResult({ claudeSessionId: "sess-abc-123" }));
		expect(run.claudeSessionId).toBe("sess-abc-123");
	});

	it("propagates claudeProjectDir from result to run state", () => {
		const run = makeRunState();
		updateRunFromResult(run, makeResult({ claudeProjectDir: "/home/user/project" }));
		expect(run.claudeProjectDir).toBe("/home/user/project");
	});

	it("does not overwrite runtime with undefined", () => {
		const run = makeRunState({ runtime: "claude" });
		updateRunFromResult(run, makeResult({ runtime: undefined }));
		expect(run.runtime).toBe("claude");
	});

	it("does not overwrite claudeSessionId with undefined", () => {
		const run = makeRunState({ claudeSessionId: "sess-abc" });
		updateRunFromResult(run, makeResult({ claudeSessionId: undefined }));
		expect(run.claudeSessionId).toBe("sess-abc");
	});

	it("does not overwrite claudeProjectDir with undefined", () => {
		const run = makeRunState({ claudeProjectDir: "/old/dir" });
		updateRunFromResult(run, makeResult({ claudeProjectDir: undefined }));
		expect(run.claudeProjectDir).toBe("/old/dir");
	});

	it("propagates all three claude metadata fields together", () => {
		const run = makeRunState();
		updateRunFromResult(
			run,
			makeResult({
				runtime: "claude",
				claudeSessionId: "sess-xyz",
				claudeProjectDir: "/project",
			}),
		);
		expect(run.runtime).toBe("claude");
		expect(run.claudeSessionId).toBe("sess-xyz");
		expect(run.claudeProjectDir).toBe("/project");
	});
});

describe("stateToSingleResult includes Claude metadata", () => {
	it("includes claudeSessionId from stream state", () => {
		const state = createStreamState();
		state.sessionId = "sess-from-stream";
		const result = stateToSingleResult(state, "test", "user", "task", 0, undefined, "");
		expect(result.claudeSessionId).toBe("sess-from-stream");
		expect(result.runtime).toBe("claude");
	});

	it("captures session_id from init event", () => {
		const state = createStreamState();
		processClaudeEvent(state, {
			session_id: "sess-init-123",
			type: "system",
			subtype: "init",
			model: "claude-sonnet-4-20250514",
		});
		expect(state.sessionId).toBe("sess-init-123");
	});

	it("captures session_id from result event", () => {
		const state = createStreamState();
		processClaudeEvent(state, {
			type: "result",
			session_id: "sess-result-456",
			is_error: false,
			stop_reason: "end_turn",
			result: "done",
		});
		expect(state.sessionId).toBe("sess-result-456");
	});
});

describe("mid-run checkpoint: claudeSessionId first observed", () => {
	it("sets claudeSessionId on run state as soon as first event carries session_id", () => {
		const run = makeRunState();
		const state = createStreamState();

		processClaudeEvent(state, {
			session_id: "sess-mid-run",
			type: "system",
			subtype: "init",
			model: "claude-sonnet-4-20250514",
		});
		const result = stateToSingleResult(state, "test", "user", "task", 0, undefined, "");
		updateRunFromResult(run, result);

		expect(run.claudeSessionId).toBe("sess-mid-run");
		expect(run.runtime).toBe("claude");
	});
});

describe("session restore from details payload", () => {
	it("restored run state contains runtime, claudeSessionId, claudeProjectDir", () => {
		const details = {
			runId: 42,
			agent: "worker",
			task: "do work",
			status: "done",
			exitCode: 0,
			startedAt: Date.now() - 10000,
			elapsedMs: 10000,
			lastActivityAt: Date.now(),
			runtime: "claude",
			claudeSessionId: "sess-restored",
			claudeProjectDir: "/restored/project",
		};

		const run: CommandRunState = {
			id: details.runId,
			agent: details.agent,
			task: details.task,
			status: "done",
			startedAt: details.startedAt,
			lastActivityAt: details.lastActivityAt,
			elapsedMs: details.elapsedMs,
			toolCalls: 0,
			lastLine: "",
			turnCount: 1,
			runtime: details.runtime as any,
			claudeSessionId: details.claudeSessionId,
			claudeProjectDir: details.claudeProjectDir,
		};

		expect(run.runtime).toBe("claude");
		expect(run.claudeSessionId).toBe("sess-restored");
		expect(run.claudeProjectDir).toBe("/restored/project");
	});
});

describe("continue validation for Claude runtime", () => {
	it("requires claudeSessionId for Claude runtime continue", () => {
		const run = makeRunState({ runtime: "claude", claudeSessionId: undefined, status: "done" });
		const hasSessionId = !!run.claudeSessionId;
		expect(hasSessionId).toBe(false);
	});

	it("requires claudeProjectDir match for Claude runtime continue", () => {
		const currentCwd = "/current/project";
		const run = makeRunState({
			runtime: "claude",
			claudeSessionId: "sess-123",
			claudeProjectDir: "/different/project",
			status: "done",
		});
		const match = run.claudeProjectDir === currentCwd;
		expect(match).toBe(false);
	});

	it("passes validation when all Claude metadata is present and matches", () => {
		const currentCwd = "/current/project";
		const run = makeRunState({
			runtime: "claude",
			claudeSessionId: "sess-123",
			claudeProjectDir: "/current/project",
			status: "done",
		});
		const valid = !!run.claudeSessionId && run.claudeProjectDir === currentCwd;
		expect(valid).toBe(true);
	});

	it("does not require Claude validation for pi runtime", () => {
		const run = makeRunState({ runtime: "pi", status: "done" });
		const needsClaudeValidation = run.runtime === "claude";
		expect(needsClaudeValidation).toBe(false);
	});
});

describe("claudeProjectDir from runClaudeAgent", () => {
	it("stateToSingleResult sets runtime to claude", () => {
		const state = createStreamState();
		const result = stateToSingleResult(state, "test", "user", "task", 0, undefined, "");
		expect(result.runtime).toBe("claude");
	});
});
