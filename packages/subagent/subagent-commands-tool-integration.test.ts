/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store.ts";
import type { SingleResult } from "./types.ts";

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
	deliverAs?: "steer" | "followUp";
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

describe("T09: command/tool metadata integration", () => {
	beforeEach(() => {
		setStdioTty(true);
		mockDiscoverAgents.mockReset();
		mockEnqueueSubagentInvocation.mockReset();
		mockRunSingleAgent.mockReset();
		mockUpdateCommandRunsWidget.mockReset();
		mockDiscoverAgents.mockReturnValue({
			agents: [
				{ name: "worker", source: "user", systemPrompt: "" },
				{ name: "reviewer", source: "user", systemPrompt: "" },
			],
			projectAgentsDir: null,
		});
		mockEnqueueSubagentInvocation.mockImplementation(async (fn: () => Promise<unknown>) => await fn());
	});

	afterEach(() => {
		restoreStdioTty();
		vi.clearAllMocks();
	});

	describe("single run via tool path", () => {
		it("auto-retries transient network failures via the tool path", async () => {
			vi.useFakeTimers();
			try {
				mockRunSingleAgent
					.mockResolvedValueOnce(
						makeResult("worker", "network task", "", {
							exitCode: 1,
							stopReason: "error",
							errorMessage: "WebSocket error",
						}),
					)
					.mockResolvedValueOnce(makeResult("worker", "network task", "recovered"));
				const { createSubagentToolExecute } = await loadToolExecute();
				const store = createStore();
				const sent: SentCall[] = [];
				const execute = createSubagentToolExecute(createPi(sent) as never, store);

				await execute(
					"call-network-retry",
					{ command: "subagent run worker -- network task" },
					undefined,
					undefined,
					createCtx(),
				);

				await waitForAssertion(() => expect(mockRunSingleAgent).toHaveBeenCalledTimes(1));
				await vi.advanceTimersByTimeAsync(2_000);
				await waitForAssertion(() => {
					expect(mockRunSingleAgent).toHaveBeenCalledTimes(2);
					expect(sent.some((call) => call.message.content?.includes("] completed"))).toBe(true);
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it("propagates failure telemetry in completion details", async () => {
			mockRunSingleAgent.mockResolvedValue(
				makeResult("worker", "heavy task", "", {
					exitCode: 1,
					stopReason: "error",
					errorMessage: "Your input exceeds the context window of this model.",
					errorClass: "context_overflow",
					peakContextTokens: 127196,
					lastToolName: "read",
					lastToolOutputChars: 9032,
				}),
			);
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const execute = createSubagentToolExecute(createPi(sent) as never, store);

			await execute(
				"call-telemetry",
				{ command: "subagent run worker -- heavy task" },
				undefined,
				undefined,
				createCtx(),
			);

			await waitForAssertion(() => {
				const failed = sent.find(
					(call) => typeof call.message.content === "string" && call.message.content.includes("] failed"),
				);
				expect(failed?.message.details).toMatchObject({
					errorClass: "context_overflow",
					peakContextTokens: 127196,
					lastToolName: "read",
					lastToolOutputChars: 9032,
				});
			});
		});

		it("reports returned abort results as aborted with structured provenance", async () => {
			mockRunSingleAgent.mockResolvedValue(
				makeResult("worker", "cancel task", "", {
					exitCode: 1,
					stopReason: "aborted",
				}),
			);
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const execute = createSubagentToolExecute(createPi(sent) as never, store);

			await execute(
				"call-returned-abort",
				{ command: "subagent run worker -- cancel task" },
				undefined,
				undefined,
				createCtx(),
			);

			await waitForAssertion(() => {
				const aborted = sent.find(
					(call) => typeof call.message.content === "string" && call.message.content.includes("] aborted"),
				);
				expect(aborted?.message.content).not.toContain("] failed");
				expect(aborted?.message.details).toMatchObject({
					errorClass: "aborted",
					stopReason: "aborted",
				});
			});
		});

		it("reports thrown aborts as aborted instead of process failures", async () => {
			mockRunSingleAgent.mockRejectedValue(new Error("Subagent was aborted"));
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const execute = createSubagentToolExecute(createPi(sent) as never, store);

			await execute(
				"call-thrown-abort",
				{ command: "subagent run worker -- cancel task" },
				undefined,
				undefined,
				createCtx(),
			);

			await waitForAssertion(() => {
				const aborted = sent.find(
					(call) => typeof call.message.content === "string" && call.message.content.includes("] aborted"),
				);
				expect(aborted?.message.details).toMatchObject({
					errorClass: "aborted",
					stopReason: "aborted",
				});
			});
		});
	});

	describe("continue via tool path", () => {
		it("clears auto-abort failure state before continuing a run", async () => {
			mockRunSingleAgent.mockResolvedValue(makeResult("worker", "keep going", "continued"));
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const execute = createSubagentToolExecute(createPi(sent) as never, store);

			store.commandRuns.set(1, {
				id: 1,
				agent: "worker",
				task: "original task",
				status: "error",
				startedAt: Date.now() - 5000,
				elapsedMs: 5000,
				toolCalls: 2,
				lastLine: "Auto-aborted after inactivity.",
				turnCount: 1,
				lastActivityAt: Date.now(),
				errorClass: "process_error",
				autoAbortReason: "Auto-aborted after inactivity.",
			});

			await execute(
				"call-continue-auto-abort",
				{ command: "subagent continue 1 -- keep going" },
				undefined,
				undefined,
				createCtx(),
			);

			await waitForAssertion(() => {
				expect(sent.some((call) => call.message.content?.includes("] completed"))).toBe(true);
			});
			expect(store.commandRuns.get(1)).toMatchObject({ status: "done" });
			expect(store.commandRuns.get(1)?.autoAbortReason).toBeUndefined();
			expect(store.commandRuns.get(1)?.errorClass).toBeUndefined();
		});

		it("continues a run with its persisted session file", async () => {
			mockRunSingleAgent.mockResolvedValue(makeResult("worker", "keep going", "continued"));
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const pi = createPi(sent);
			const execute = createSubagentToolExecute(pi as never, store);
			const ctx = createCtx();

			store.commandRuns.set(1, {
				id: 1,
				agent: "worker",
				task: "original task",
				status: "done",
				startedAt: Date.now() - 5000,
				elapsedMs: 5000,
				toolCalls: 2,
				lastLine: "done",
				turnCount: 1,
				lastActivityAt: Date.now(),
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
				"worker",
				expect.any(String),
				undefined,
				expect.anything(),
				expect.any(Function),
				expect.any(Function),
				{
					sessionFile: "/tmp/session-1.jsonl",
					persistedSessionBaseOffset: 0,
					onDiagnostic: expect.any(Function),
				},
			);
		});
	});

	describe("batch analytics", () => {
		it("batch analytics summary includes context/tool telemetry", async () => {
			mockRunSingleAgent.mockImplementation(
				async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
					return makeResult(agentName, task, "done", {
						peakContextTokens: 42000,
						lastToolName: "bash",
						lastToolOutputChars: 321,
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
					command: 'subagent batch --main --agent reviewer --task "task1" --agent worker --task "task2"',
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
				const workerSummary = summaries.find((s) => s.agent === "worker");
				expect(workerSummary).toMatchObject({
					peakContextTokens: 42000,
					lastToolName: "bash",
					lastToolOutputChars: 321,
				});
			});
		});
	});

	describe("detail output", () => {
		it("detail command omits runtime metadata", async () => {
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

	describe("parse error rendering", () => {
		it("does not append full CLI help for unclosed-quote syntax errors", async () => {
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const execute = createSubagentToolExecute(createPi(sent) as never, store);

			const result = await execute(
				"call-unclosed-quote",
				{ command: 'subagent run worker -- "open quote' },
				undefined,
				undefined,
				createCtx(),
			);

			expect(result.isError).toBe(true);
			const text = result.content[0]?.text ?? "";
			expect(text).toBe(
				"❌ Syntax error: Unclosed quote in command.\nClose the quote or wrap the task after `--` in matching quotes.",
			);
			expect(text).not.toContain("Subagent CLI (LLM interface)");
		});

		it("still appends full CLI help for other parse errors", async () => {
			const { createSubagentToolExecute } = await loadToolExecute();
			const store = createStore();
			const sent: SentCall[] = [];
			const execute = createSubagentToolExecute(createPi(sent) as never, store);

			const result = await execute(
				"call-non-syntax-error",
				{ command: "subagent run worker --agent" },
				undefined,
				undefined,
				createCtx(),
			);

			expect(result.isError).toBe(true);
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Subagent CLI (LLM interface)");
		});
	});
});
