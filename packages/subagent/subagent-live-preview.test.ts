/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { describe, expect, it } from "vitest";
import {
	extractActivityPreviewFromTextDelta,
	extractThoughtText,
	formatPiToolExecutionPreview,
} from "./live-preview.ts";
import { updateRunFromResult } from "./store.ts";
import type { CommandRunState } from "./types.ts";

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

describe("live preview helpers", () => {
	it("extractThoughtText strips markdown like Claude thought previews", () => {
		expect(extractThoughtText("## **Searching** `payment` details\nNext line")).toBe("Searching payment details");
	});

	it("extractActivityPreviewFromTextDelta uses the last non-empty line", () => {
		expect(extractActivityPreviewFromTextDelta("First line\n\nSecond line\n")).toBe("Second line");
	});

	it("formatPiToolExecutionPreview formats Pi tool calls with readable args", () => {
		expect(formatPiToolExecutionPreview("read", { path: "/tmp/a.txt", offset: 2, limit: 3 })).toBe(
			"→ read /tmp/a.txt:2-4",
		);
	});
});

describe("updateRunFromResult with liveActivityPreview", () => {
	it("uses liveActivityPreview for lastLine when present", () => {
		const run = makeRunState();
		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			liveActivityPreview: '\u2192 Bash({"command": "ls"})',
		});

		expect(run.lastLine).toBe('\u2192 Bash({"command": "ls"})');
	});

	it("updates lastActivityAt when liveActivityPreview is present even without display changes", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({
			lastActivityAt: oldTimestamp,
			lastLine: "\u2192 Bash",
		});

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			liveActivityPreview: "\u2192 Bash",
		});

		expect(run.lastActivityAt).toBeGreaterThan(oldTimestamp);
	});

	it("updates lastActivityAt when liveText is present", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({ lastActivityAt: oldTimestamp });

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			liveText: "streaming text",
		});

		expect(run.lastActivityAt).toBeGreaterThan(oldTimestamp);
	});

	it("updates lastActivityAt when liveThinking is present", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({ lastActivityAt: oldTimestamp });

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			liveThinking: "analyzing edge cases",
		});

		expect(run.lastActivityAt).toBeGreaterThan(oldTimestamp);
	});

	it("treats persisted toolResult output as activity even without assistant text changes", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({ lastActivityAt: oldTimestamp, lastLine: "working..." });

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [
				{
					role: "toolResult",
					toolName: "Bash",
					content: [{ type: "text", text: "command finished successfully" }],
				} as any,
			],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		});

		expect(run.lastLine).toContain("Bash");
		expect(run.lastLine).toContain("command finished successfully");
		expect(run.lastActivityAt).toBeGreaterThan(oldTimestamp);
	});

	it("updates lastActivityAt when thoughtText changes", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({ lastActivityAt: oldTimestamp, thoughtText: "old thought" });

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			thoughtText: "new thought",
		});

		expect(run.lastActivityAt).toBeGreaterThan(oldTimestamp);
	});

	it("does not update lastActivityAt without any live activity or state changes", () => {
		const oldTimestamp = Date.now() - 30000;
		const run = makeRunState({ lastActivityAt: oldTimestamp });

		updateRunFromResult(run, {
			agent: "test",
			agentSource: "user",
			task: "task",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		});

		expect(run.lastActivityAt).toBe(oldTimestamp);
	});
});
