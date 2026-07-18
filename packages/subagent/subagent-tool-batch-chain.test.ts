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
		cwd: process.cwd(),
		hasUI: true,
		sessionManager: {
			getSessionFile: () => "/tmp/main-session.jsonl",
			getEntries: () => [],
		},
	};
}

async function waitForAssertion(assertion: () => void, attempts = 20): Promise<void> {
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

describe("createSubagentToolExecute batch/chain grouped behavior", () => {
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

	it("propagates parent tool abort signal to headless synchronous child run", async () => {
		setStdioTty(false);
		const parentAbortController = new AbortController();
		mockRunSingleAgent.mockImplementation(
			async (_cwd: unknown, _agents: unknown, agentName: string, task: string, _step: unknown, signal: AbortSignal) => {
				expect(signal).toBeDefined();
				expect(signal.aborted).toBe(false);
				parentAbortController.abort();
				expect(signal.aborted).toBe(true);
				return makeResult(agentName, task, "HEADLESS_DONE");
			},
		);
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = { ...createCtx(), hasUI: false };

		const result = await execute(
			"call-headless-abort",
			{ command: "subagent run worker -- headless abort propagation" },
			parentAbortController.signal,
			undefined,
			ctx,
		);

		expect(result.content[0]?.text).toContain("[subagent:worker#1] completed");
		expect(result.content[0]?.text).toContain("HEADLESS_DONE");
		expect(sent).toHaveLength(0);
	});

	it("keeps interactive async child run independent from parent tool abort signal", async () => {
		setStdioTty(true);
		const parentAbortController = new AbortController();
		mockRunSingleAgent.mockImplementation(
			async (_cwd: unknown, _agents: unknown, agentName: string, task: string, _step: unknown, signal: AbortSignal) => {
				expect(signal).toBeDefined();
				expect(signal.aborted).toBe(false);
				parentAbortController.abort();
				expect(signal.aborted).toBe(false);
				return makeResult(agentName, task, "ASYNC_DONE");
			},
		);
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-async-parent-abort",
			{ command: "subagent run worker -- async parent abort isolation" },
			parentAbortController.signal,
			undefined,
			ctx,
		);

		expect(result.content[0]?.text).toContain("Started async subagent run #1");
		await waitForAssertion(() => {
			expect(sent).toHaveLength(2);
		});
		expect(sent[1]?.message.content).toContain("ASYNC_DONE");
	});

	it("emits only grouped batch follow-up and no per-member follow-ups", async () => {
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			return makeResult(agentName, task, agentName === "worker" ? "NB_A" : "NB_B");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-1",
			{
				command: 'subagent batch --main --agent worker --task "batch a" --agent reviewer --task "batch b"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0]?.text).toContain("Started async subagent batch");
		const batchLaunches = result.details.launches ?? [];
		expect(batchLaunches).toHaveLength(2);
		expect(batchLaunches[0]).toMatchObject({ agent: "worker", mode: "batch", runId: 1, stepIndex: 0 });
		expect(batchLaunches[1]).toMatchObject({ agent: "reviewer", mode: "batch", runId: 2, stepIndex: 1 });
		expect(batchLaunches[0]?.batchId).toBe(batchLaunches[1]?.batchId);
		await waitForAssertion(() => {
			expect(sent).toHaveLength(1);
		});
		expect(sent[0]?.message.content).toContain("[subagent-batch#");
		expect(sent[0]?.message.content).toContain("NB_A");
		expect(sent[0]?.message.content).toContain("NB_B");
		expect(sent[0]?.message.content).not.toContain("[subagent:worker#");
		expect(sent[0]?.message.content).not.toContain("[subagent:reviewer#");
		expect(sent[0]?.message.details).toMatchObject({
			status: "done",
			runIds: [1, 2],
			runSummaries: [
				{ agent: "worker", runId: 1, status: "done", stepIndex: 0 },
				{ agent: "reviewer", runId: 2, status: "done", stepIndex: 1 },
			],
		});
	});

	it("passes previous-step reference to later chain steps while emitting only grouped follow-up", async () => {
		const seenTasks: string[] = [];
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			seenTasks.push(task);
			return makeResult(agentName, task, agentName === "worker" ? "CHAIN_TOKEN_TEST" : "CHAIN_SEEN_OK");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-2",
			{
				command: 'subagent chain --main --agent worker --task "step one" --agent reviewer --task "step two"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0]?.text).toContain("Started async subagent chain");
		const chainLaunches = result.details.launches ?? [];
		expect(chainLaunches).toHaveLength(1);
		expect(chainLaunches[0]).toMatchObject({ agent: "worker", mode: "chain", runId: 1, stepIndex: 0 });
		await waitForAssertion(() => {
			expect(seenTasks).toHaveLength(2);
			expect(sent).toHaveLength(1);
		});
		expect(seenTasks[1]).toContain("[PIPELINE PREVIOUS STEP — REFERENCE ONLY]");
		expect(seenTasks[1]).toContain("CHAIN_TOKEN_TEST");
		expect(seenTasks[1]).toContain("[REQUEST — AUTHORITATIVE]\nstep two");
		expect(sent[0]?.message.content).toContain("[subagent-chain#");
		expect(sent[0]?.message.content).toContain("CHAIN_SEEN_OK");
		expect(sent[0]?.message.content).not.toContain("[subagent:worker#");
		expect(sent[0]?.message.content).not.toContain("[subagent:reviewer#");
		expect(sent[0]?.message.details).toMatchObject({
			status: "done",
			stepRunIds: [1, 2],
			runSummaries: [
				{ agent: "worker", runId: 1, status: "done", stepIndex: 0 },
				{ agent: "reviewer", runId: 2, status: "done", stepIndex: 1 },
			],
		});
	});

	it("reports only actually launched chain steps when the first step fails early", async () => {
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			if (agentName === "worker") {
				return makeResult(agentName, task, "FIRST_STEP_FAILED", {
					exitCode: 1,
					stderr: "boom",
					messages: [],
				});
			}
			return makeResult(agentName, task, "UNREACHABLE_SECOND_STEP");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-3",
			{
				command: 'subagent chain --main --agent worker --task "step one" --agent reviewer --task "step two"',
			},
			undefined,
			undefined,
			ctx,
		);

		const chainLaunches = result.details.launches ?? [];
		expect(chainLaunches).toHaveLength(1);
		expect(chainLaunches[0]).toMatchObject({ agent: "worker", mode: "chain", runId: 1, stepIndex: 0 });
		await waitForAssertion(() => {
			expect(sent).toHaveLength(1);
		});
		expect(sent[0]?.message.content).toContain("[subagent-chain#");
		expect(sent[0]?.message.content).toContain("Subagent process exited with code 1.");
		expect(sent[0]?.message.details).toMatchObject({
			status: "error",
			stepRunIds: [1],
			runSummaries: [{ agent: "worker", runId: 1, status: "error", stepIndex: 0 }],
		});
	});

	it("reports live batch progress when queried by groupId", async () => {
		let releaseRuns: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseRuns = resolve;
		});
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			await gate;
			return makeResult(agentName, task, agentName === "worker" ? "LIVE_A" : "LIVE_B");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const launch = await execute(
			"call-live-batch",
			{ command: 'subagent batch --main --agent worker --task "live a" --agent reviewer --task "live b"' },
			undefined,
			undefined,
			ctx,
		);
		const batchId = launch.details.launches?.[0]?.batchId as string;
		expect(batchId).toMatch(/^b_/);

		const status = await execute(
			"call-live-batch-status",
			{ command: `subagent status ${batchId}` },
			undefined,
			undefined,
			ctx,
		);
		expect(status.isError).toBeFalsy();
		expect(status.content[0]?.text).toContain(`[subagent-batch#${batchId}]`);
		expect(status.content[0]?.text).toContain("0/2 finished");

		releaseRuns();
		await waitForAssertion(() => {
			expect(sent).toHaveLength(1);
		});
	});

	it("returns an error when querying an unknown groupId", async () => {
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-unknown-group",
			{ command: "subagent status b_does_not_exist" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Unknown or already-finished subagent group");
	});
});
