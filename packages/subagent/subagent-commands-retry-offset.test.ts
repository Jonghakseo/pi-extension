/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store.ts";
import type { SingleResult } from "./types.ts";

const mockDiscoverAgents = vi.hoisted(() => vi.fn());
const mockEnqueueSubagentInvocation = vi.hoisted(() => vi.fn());
const mockRunSingleAgent = vi.hoisted(() => vi.fn());
const mockUpdateCommandRunsWidget = vi.hoisted(() => vi.fn());

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

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] } as never],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		...overrides,
	};
}

function createPi() {
	const commands = new Map<string, any>();
	return {
		commands,
		pi: {
			registerTool: vi.fn(),
			registerCommand: vi.fn((name: string, command: any) => {
				commands.set(name, command);
			}),
			registerShortcut: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		},
	};
}

describe("commands retry persisted-session offset refresh", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.useFakeTimers();
		mockDiscoverAgents.mockReset();
		mockEnqueueSubagentInvocation.mockReset();
		mockRunSingleAgent.mockReset();
		mockUpdateCommandRunsWidget.mockReset();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-retry-offset-"));
		mockDiscoverAgents.mockReturnValue({
			agents: [{ name: "worker", source: "user", systemPrompt: "", runtime: "pi" }],
			projectAgentsDir: null,
		});
		mockEnqueueSubagentInvocation.mockImplementation(async (fn: () => Promise<unknown>) => await fn());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("refreshes persistedSessionBaseOffset before each retry attempt", async () => {
		const { registerAll } = await import("./commands.ts");
		const store = createStore();
		const { pi, commands } = createPi();
		registerAll(pi as never, store);

		let firstCallConfig: any;
		let secondCallConfig: any;
		mockRunSingleAgent
			.mockImplementationOnce(async (...args: unknown[]) => {
				firstCallConfig = args[8] as { sessionFile: string };
				fs.appendFileSync(
					firstCallConfig.sessionFile,
					`${JSON.stringify({
						type: "message",
						timestamp: Date.now(),
						message: {
							role: "assistant",
							stopReason: "stop",
							timestamp: Date.now(),
							content: [{ type: "text", text: "attempt 1 output" }],
						},
					})}\n${JSON.stringify({ type: "subagent_done", timestamp: Date.now(), exitCode: 0, stopReason: "stop", runtime: "pi" })}\n`,
					"utf8",
				);
				return makeResult({ exitCode: 1, messages: [], stderr: "network timeout" });
			})
			.mockImplementationOnce(async (...args: unknown[]) => {
				secondCallConfig = args[8] as { persistedSessionBaseOffset: number };
				return makeResult();
			});

		const handler = commands.get("sub:isolate")?.handler;
		expect(handler).toBeTypeOf("function");

		const ctx = {
			cwd: tmpDir,
			hasUI: false,
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				getEditorText: vi.fn(() => ""),
				setEditorText: vi.fn(),
			},
			sessionManager: {
				getSessionFile: () => path.join(tmpDir, "main.jsonl"),
				getEntries: () => [],
			},
		};

		await handler("worker do work", ctx);
		await vi.runAllTicks();
		expect(mockRunSingleAgent).toHaveBeenCalledTimes(1);
		expect(firstCallConfig.persistedSessionBaseOffset).toBe(0);

		await vi.advanceTimersByTimeAsync(2000);
		await vi.runAllTicks();
		await vi.advanceTimersByTimeAsync(1000);
		await vi.runOnlyPendingTimersAsync();

		expect(mockRunSingleAgent).toHaveBeenCalledTimes(2);
		expect(secondCallConfig.persistedSessionBaseOffset).toBeGreaterThan(firstCallConfig.persistedSessionBaseOffset);
	});
});
