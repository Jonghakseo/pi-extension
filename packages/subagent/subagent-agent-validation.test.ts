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

function createNonTuiCtx(): ToolCtx {
	return {
		...createCtx(),
		hasUI: false,
	};
}

describe("early agent name validation", () => {
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

	// ── single run ──────────────────────────────────────────────

	it("rejects single run with unknown agent name", async () => {
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-1",
			{ command: "subagent run ghost-agent -- do something" },
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Unknown agent");
		expect(result.content[0]?.text).toContain('"ghost-agent"');
		expect(result.content[0]?.text).toContain("Available agents");
		// Should NOT have spawned any process
		expect(mockRunSingleAgent).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
	});

	it("allows single run with a valid agent name", async () => {
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			return makeResult(agentName, task, "OK");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-2",
			{ command: "subagent run worker -- do something" },
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("Started async subagent run");
	});

	it("returns the final result synchronously outside TUI interactive mode", async () => {
		setStdioTty(false);
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			return makeResult(agentName, task, "SYNC_OK");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createNonTuiCtx();

		const result = await execute(
			"call-2b",
			{ command: "subagent run worker -- do something" },
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("[subagent:worker#1] completed");
		expect(result.content[0]?.text).toContain("SYNC_OK");
		expect(result.details.results).toHaveLength(1);
		expect(sent).toHaveLength(0);
	});

	// ── batch ───────────────────────────────────────────────────

	it("rejects batch when one agent is unknown", async () => {
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-3",
			{
				command: 'subagent batch --agent worker --task "A" --agent phantom --task "B"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Unknown agent");
		expect(result.content[0]?.text).toContain('"phantom"');
		expect(mockRunSingleAgent).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
	});

	it("rejects batch when all agents are unknown", async () => {
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-4",
			{
				command: 'subagent batch --agent ghost --task "A" --agent phantom --task "B"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Unknown agents");
		expect(result.content[0]?.text).toContain('"ghost"');
		expect(result.content[0]?.text).toContain('"phantom"');
		expect(mockRunSingleAgent).not.toHaveBeenCalled();
	});

	it("allows batch when all agents are valid", async () => {
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			return makeResult(agentName, task, "OK");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-5",
			{
				command: 'subagent batch --agent worker --task "A" --agent reviewer --task "B"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("Started async subagent batch");
	});

	// ── chain ───────────────────────────────────────────────────

	it("rejects chain when one agent is unknown", async () => {
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-6",
			{
				command: 'subagent chain --agent worker --task "step 1" --agent nope --task "step 2"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Unknown agent");
		expect(result.content[0]?.text).toContain('"nope"');
		expect(mockRunSingleAgent).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
	});

	it("allows chain when all agents are valid", async () => {
		mockRunSingleAgent.mockImplementation(async (_cwd: unknown, _agents: unknown, agentName: string, task: string) => {
			return makeResult(agentName, task, "OK");
		});
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-7",
			{
				command: 'subagent chain --agent worker --task "step 1" --agent reviewer --task "step 2"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("Started async subagent chain");
	});

	// ── deduplication ───────────────────────────────────────────

	it("deduplicates unknown agent names in error message", async () => {
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute(
			"call-8",
			{
				command: 'subagent batch --agent ghost --task "A" --agent ghost --task "B"',
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBe(true);
		// "ghost" appears only once in the error (deduplicated)
		const errorText = result.content[0]?.text ?? "";
		const matches = errorText.match(/"ghost"/g);
		expect(matches).toHaveLength(1);
	});

	// ── available agents list ───────────────────────────────────

	it("includes all available agent names in error message", async () => {
		const { createSubagentToolExecute } = await loadToolExecute();
		const store = createStore();
		const sent: SentCall[] = [];
		const pi = createPi(sent);
		const execute = createSubagentToolExecute(pi as never, store);
		const ctx = createCtx();

		const result = await execute("call-9", { command: "subagent run unknown -- test" }, undefined, undefined, ctx);

		expect(result.isError).toBe(true);
		const errorText = result.content[0]?.text ?? "";
		expect(errorText).toContain('"worker"');
		expect(errorText).toContain('"reviewer"');
	});
});
