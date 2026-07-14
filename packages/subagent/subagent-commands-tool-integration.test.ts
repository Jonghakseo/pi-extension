/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, updateRunFromResult } from "./store.ts";
import type { CommandRunState, SingleResult } from "./types.ts";

const mockDiscoverAgents = vi.fn();
const mockEnqueueSubagentInvocation = vi.fn();
const mockRunSingleAgent = vi.fn();
const mockUpdateCommandRunsWidget = vi.fn();
const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

function setStdioTty(isTTY: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: isTTY });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
}

function restoreStdioTty(): void {
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalStdinIsTTY });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalStdoutIsTTY });
}

vi.mock("./agents.js", () => ({
	discoverAgents: (...args: unknown[]) => mockDiscoverAgents(...args),
}));

vi.mock("./invocation-queue.js", () => ({
	enqueueSubagentInvocation: (...args: unknown[]) => mockEnqueueSubagentInvocation(...args),
}));

vi.mock("./widget.js", () => ({
	updateCommandRunsWidget: (...args: unknown[]) => mockUpdateCommandRunsWidget(...args),
}));

vi.mock("./runner.js", async () => {
	const actual = await vi.importActual<typeof import("./runner.js")>("./runner.js");
	return {
		...actual,
		runSingleAgent: (...args: unknown[]) => mockRunSingleAgent(...args),
	};
});

type SentMessage = {
	content?: string;
	details?: Record<string, unknown>;
};

type SentOptions = {
	deliverAs?: "followUp";
	triggerTurn?: boolean;
};

type SentCall = {
	message: SentMessage;
	options: SentOptions | undefined;
};

type ToolCtx = {
	cwd: string;
	hasUI: boolean;
	sessionManager: {
		getSessionFile: () => string;
		getEntries: () => unknown[];
	};
	ui?: {
		setWidget: (...args: unknown[]) => void;
		notify?: (...args: unknown[]) => void;
	};
};

function makeResult(agent: string, task: string, text: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent,
		agentSource: "user",
		task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as never],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		...overrides,
	};
}

async function loadToolExecute() {
	vi.resetModules();
	return await import("./tool-execute.ts");
}

function createPi(sent: SentCall[]) {
	return {
		sendMessage: vi.fn((message: SentMessage, options?: SentOptions) => {
			sent.push({ message, options });
		}),
	};
}

function createCtx(): ToolCtx {
	return {
		cwd: "/tmp/test-project",
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/tmp/main-session.jsonl",
			getEntries: () => [],
		},
		ui: {
			setWidget: vi.fn(),
			notify: vi.fn(),
		},
	};
}

async function waitForAssertion(assertion: () => void, attempts = 30): Promise<void> {
	let lastError: unknown;
	for (let index = 0; index < attempts; index++) {
		try {
			assertion();
			return;
		} catch (error: unknown) {
			lastError = error;
			await Promise.resolve();
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Assertion did not pass in time");
}

describe("T09: command/tool runtime metadata integration", () => {
	beforeEach(() => {
		setStdioTty(true);
		mockDiscoverAgents.mockReset();
		mockEnqueueSubagentInvocation.mockReset();
		mockRunSingleAgent.mockReset();
		mockUpdateCommandRunsWidget.mockReset();
		mockDiscoverAgents.mockReturnValue({
			agents: [
				{ name: "worker", source: "user", systemPrompt: "", runtime: "pi" },
				{ name: "claude-worker", source: "user", systemPrompt: "", runtime: "claude", model: "claude-sonnet-4-6" },
				{ name: "reviewer", source: "user", systemPrompt: "", runtime: "pi" },
			],
			projectAgentsDir: null,
		});
		mockEnqueueSubagentInvocation.mockImplementation(async (fn: () => Promise<unknown>) => await fn());
	});

	afterEach(() => {
		restoreStdioTty();
		vi.clearAllMocks();
	});

	describe("single run: Claude runtime metadata propagation via tool path", () => {
		it("propagates runtime, claudeSessionId, claudeProjectDir in completion message", async () => {
			mockRunSingleAgent.mockImplementation(async () => {
				return makeResult("claude-worker", "do work", "work done", {
					runtime: "claude",
					claudeSessionId: "sess-tool-123",
					claudeProjectDir: "/tmp/test-project",
				});
			});
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const pi = createPi(sent);
			const execute = createSubagentToolExecute(pi as never, store);
			const ctx = createCtx();

			await execute("call-1", { command: "subagent run claude-worker --main -- do work" }, undefined, undefined, ctx);

			await waitForAssertion(() => {
				const completionMsgs = sent.filter(
					(s) => typeof s.message.content === "string" && s.message.content.includes("] completed"),
				);
				expect(completionMsgs).toHaveLength(1);
				const details = completionMsgs[0]?.message.details as Record<string, unknown> | undefined;
				expect(details?.runtime).toBe("claude");
				expect(details?.claudeSessionId).toBe("sess-tool-123");
				expect(details?.claudeProjectDir).toBe("/tmp/test-project");
			});
		});

		it("propagates runtime metadata to run state via updateRunFromResult", () => {
			const run: CommandRunState = {
				id: 1,
				agent: "claude-worker",
				task: "test",
				status: "running",
				startedAt: Date.now() - 1000,
				elapsedMs: 1000,
				toolCalls: 0,
				lastLine: "",
				turnCount: 0,
				lastActivityAt: Date.now() - 1000,
			};
			const result = makeResult("claude-worker", "test", "done", {
				runtime: "claude",
				claudeSessionId: "sess-abc",
				claudeProjectDir: "/project",
			});
			updateRunFromResult(run, result);
			expect(run.runtime).toBe("claude");
			expect(run.claudeSessionId).toBe("sess-abc");
			expect(run.claudeProjectDir).toBe("/project");
		});
	});

	describe("continue: Claude runtime validation via tool path", () => {
		it("rejects continue for Claude run without claudeSessionId", async () => {
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const pi = createPi(sent);
			const execute = createSubagentToolExecute(pi as never, store);
			const ctx = createCtx();

			store.commandRuns.set(1, {
				id: 1,
				agent: "claude-worker",
				task: "original task",
				status: "done",
				startedAt: Date.now() - 5000,
				elapsedMs: 5000,
				toolCalls: 2,
				lastLine: "done",
				turnCount: 1,
				lastActivityAt: Date.now(),
				runtime: "claude",
				claudeSessionId: undefined,
				claudeProjectDir: "/tmp/test-project",
			});

			const result = await execute(
				"call-2",
				{ command: "subagent continue 1 -- keep going" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("no claudeSessionId");
		});

		it("rejects continue for Claude run with mismatched claudeProjectDir", async () => {
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const pi = createPi(sent);
			const execute = createSubagentToolExecute(pi as never, store);
			const ctx = createCtx();

			store.commandRuns.set(1, {
				id: 1,
				agent: "claude-worker",
				task: "original task",
				status: "done",
				startedAt: Date.now() - 5000,
				elapsedMs: 5000,
				toolCalls: 2,
				lastLine: "done",
				turnCount: 1,
				lastActivityAt: Date.now(),
				runtime: "claude",
				claudeSessionId: "sess-123",
				claudeProjectDir: "/different/project",
			});

			const result = await execute(
				"call-3",
				{ command: "subagent continue 1 -- keep going" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("claudeProjectDir mismatch");
		});

		it("allows continue for Claude run with valid metadata", async () => {
			mockRunSingleAgent.mockImplementation(async () => {
				return makeResult("claude-worker", "keep going", "continued", {
					runtime: "claude",
					claudeSessionId: "sess-123",
					claudeProjectDir: "/tmp/test-project",
				});
			});
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const pi = createPi(sent);
			const execute = createSubagentToolExecute(pi as never, store);
			const ctx = createCtx();

			store.commandRuns.set(1, {
				id: 1,
				agent: "claude-worker",
				task: "original task",
				status: "done",
				startedAt: Date.now() - 5000,
				elapsedMs: 5000,
				toolCalls: 2,
				lastLine: "done",
				turnCount: 1,
				lastActivityAt: Date.now(),
				runtime: "claude",
				claudeSessionId: "sess-123",
				claudeProjectDir: "/tmp/test-project",
				sessionFile: "/tmp/session-1.jsonl",
			});
			store.nextCommandRunId = 2;

			const result = await execute(
				"call-4",
				{ command: "subagent continue 1 -- keep going" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBeUndefined();
			expect(result.content[0]?.text).toContain("Resumed");
			expect(mockRunSingleAgent).toHaveBeenCalledWith(
				"/tmp/test-project",
				expect.any(Array),
				"claude-worker",
				expect.any(String),
				undefined,
				expect.anything(),
				expect.any(Function),
				expect.any(Function),
				{
					sessionFile: "/tmp/session-1.jsonl",
					resumeSessionId: "sess-123",
					sidecarSessionFile: "/tmp/session-1.jsonl",
					persistedSessionBaseOffset: 0,
					onDiagnostic: expect.any(Function),
				},
			);
		});
	});

	describe("batch: mixed pi + claude runtime", () => {
		it("each batch run gets its own runtime from the result", async () => {
			mockRunSingleAgent.mockImplementation(
				async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
					if (agentName === "claude-worker") {
						return makeResult(agentName, task, "claude output", {
							runtime: "claude",
							claudeSessionId: "sess-batch-claude",
							claudeProjectDir: "/tmp/test-project",
						});
					}
					return makeResult(agentName, task, "pi output", {
						runtime: "pi",
					});
				},
			);
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const pi = createPi(sent);
			const execute = createSubagentToolExecute(pi as never, store);
			const ctx = createCtx();

			await execute(
				"call-5",
				{
					command: 'subagent batch --main --agent claude-worker --task "claude task" --agent worker --task "pi task"',
				},
				undefined,
				undefined,
				ctx,
			);

			await waitForAssertion(() => {
				const batchMsgs = sent.filter(
					(s) => typeof s.message.content === "string" && s.message.content.includes("[subagent-batch#"),
				);
				expect(batchMsgs).toHaveLength(1);
			});

			const runs = Array.from(store.commandRuns.values());
			const claudeRun = runs.find((r) => r.agent === "claude-worker");
			const piRun = runs.find((r) => r.agent === "worker");
			expect(claudeRun?.runtime).toBe("claude");
			expect(claudeRun?.claudeSessionId).toBe("sess-batch-claude");
			expect(piRun?.runtime).toBe("pi");
		});

		it("batch analytics summary includes runtime field", async () => {
			mockRunSingleAgent.mockImplementation(
				async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
					return makeResult(agentName, task, "done", {
						runtime: agentName === "claude-worker" ? "claude" : "pi",
					});
				},
			);
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const pi = createPi(sent);
			const execute = createSubagentToolExecute(pi as never, store);
			const ctx = createCtx();

			await execute(
				"call-6",
				{
					command: 'subagent batch --main --agent claude-worker --task "task1" --agent worker --task "task2"',
				},
				undefined,
				undefined,
				ctx,
			);

			await waitForAssertion(() => {
				const batchMsgs = sent.filter(
					(s) => typeof s.message.content === "string" && s.message.content.includes("[subagent-batch#"),
				);
				expect(batchMsgs).toHaveLength(1);
				const details = batchMsgs[0]?.message.details as Record<string, unknown>;
				const summaries = details?.runSummaries as Array<Record<string, unknown>>;
				expect(summaries).toBeDefined();
				const claudeSummary = summaries.find((s) => s.agent === "claude-worker");
				const piSummary = summaries.find((s) => s.agent === "worker");
				expect(claudeSummary?.runtime).toBe("claude");
				expect(piSummary?.runtime).toBe("pi");
			});
		});
	});

	describe("detail: Claude runtime info in detail output", () => {
		it("detail command shows runtime and Claude session for Claude runs", async () => {
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const pi = createPi(sent);
			const execute = createSubagentToolExecute(pi as never, store);
			const ctx = createCtx();

			store.commandRuns.set(1, {
				id: 1,
				agent: "claude-worker",
				task: "some task",
				status: "done",
				startedAt: Date.now() - 5000,
				elapsedMs: 5000,
				toolCalls: 3,
				lastLine: "final line",
				lastOutput: "some output",
				turnCount: 2,
				lastActivityAt: Date.now(),
				runtime: "claude",
				claudeSessionId: "sess-detail-456",
				claudeProjectDir: "/tmp/test-project",
			});
			store.nextCommandRunId = 2;

			const result = await execute("call-7", { command: "subagent detail 1" }, undefined, undefined, ctx);

			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Runtime: claude");
			expect(text).toContain("Claude Session: sess-detail-456");
		});

		it("detail command does not show runtime for pi runs without runtime field", async () => {
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const pi = createPi(sent);
			const execute = createSubagentToolExecute(pi as never, store);
			const ctx = createCtx();

			store.commandRuns.set(1, {
				id: 1,
				agent: "worker",
				task: "some task",
				status: "done",
				startedAt: Date.now() - 5000,
				elapsedMs: 5000,
				toolCalls: 3,
				lastLine: "final line",
				lastOutput: "some output",
				turnCount: 2,
				lastActivityAt: Date.now(),
			});
			store.nextCommandRunId = 2;

			const result = await execute("call-8", { command: "subagent detail 1" }, undefined, undefined, ctx);

			expect(result.isError).toBeUndefined();
			const text = result.content[0]?.text ?? "";
			expect(text).not.toContain("Runtime:");
			expect(text).not.toContain("Claude Session:");
		});
	});

	describe("metadata format consistency: command vs tool path", () => {
		it("updateRunFromResult propagates identical metadata regardless of source", () => {
			const commandRun: CommandRunState = {
				id: 1,
				agent: "claude-worker",
				task: "cmd task",
				status: "running",
				startedAt: Date.now(),
				elapsedMs: 0,
				toolCalls: 0,
				lastLine: "",
				turnCount: 0,
				lastActivityAt: Date.now(),
			};

			const toolRun: CommandRunState = {
				id: 2,
				agent: "claude-worker",
				task: "tool task",
				status: "running",
				startedAt: Date.now(),
				elapsedMs: 0,
				toolCalls: 0,
				lastLine: "",
				turnCount: 0,
				lastActivityAt: Date.now(),
				source: "tool",
			};

			const claudeResult = makeResult("claude-worker", "test", "done", {
				runtime: "claude",
				claudeSessionId: "sess-shared",
				claudeProjectDir: "/shared/project",
			});

			updateRunFromResult(commandRun, claudeResult);
			updateRunFromResult(toolRun, claudeResult);

			expect(commandRun.runtime).toBe(toolRun.runtime);
			expect(commandRun.claudeSessionId).toBe(toolRun.claudeSessionId);
			expect(commandRun.claudeProjectDir).toBe(toolRun.claudeProjectDir);
			expect(commandRun.runtime).toBe("claude");
			expect(commandRun.claudeSessionId).toBe("sess-shared");
			expect(commandRun.claudeProjectDir).toBe("/shared/project");
		});

		it("pi runtime runs do not get claude metadata", () => {
			const run: CommandRunState = {
				id: 1,
				agent: "worker",
				task: "pi task",
				status: "running",
				startedAt: Date.now(),
				elapsedMs: 0,
				toolCalls: 0,
				lastLine: "",
				turnCount: 0,
				lastActivityAt: Date.now(),
			};

			const piResult = makeResult("worker", "pi task", "done", {
				runtime: "pi",
			});

			updateRunFromResult(run, piResult);
			expect(run.runtime).toBe("pi");
			expect(run.claudeSessionId).toBeUndefined();
			expect(run.claudeProjectDir).toBeUndefined();
		});
	});
});
