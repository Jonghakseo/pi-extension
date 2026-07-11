/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentExtension, { shutdownSubagentRuns } from "./index.ts";
import { createStore } from "./store.ts";
import type { CommandRunState } from "./types.ts";

function createPi() {
	const handlers = new Map<string, any[]>();
	return {
		handlers,
		pi: {
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			on: vi.fn((event: string, handler: any) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			}),
			sendMessage: vi.fn(),
		},
	};
}

function makeRun(overrides: Partial<CommandRunState> = {}): CommandRunState {
	return {
		id: 1,
		agent: "worker",
		task: "task",
		status: "running",
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		elapsedMs: 0,
		toolCalls: 0,
		lastLine: "running",
		turnCount: 1,
		...overrides,
	};
}

describe("subagent extension lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("starts the hang timer only after session_start and clears it on shutdown", async () => {
		vi.useFakeTimers();
		const { pi, handlers } = createPi();
		subagentExtension(pi as never);

		expect(vi.getTimerCount()).toBe(0);

		const unsubscribeTerminalInput = vi.fn();
		const ctx = {
			cwd: "/tmp/project",
			hasUI: false,
			ui: { onTerminalInput: vi.fn(() => unsubscribeTerminalInput), setWidget: vi.fn() },
			sessionManager: { getSessionFile: () => "/tmp/main.jsonl", getEntries: () => [] },
		};
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, ctx);
		}
		expect(vi.getTimerCount()).toBe(1);

		for (const handler of handlers.get("session_shutdown") ?? []) {
			await handler({ type: "session_shutdown", reason: "reload" }, ctx);
		}
		expect(vi.getTimerCount()).toBe(0);
		expect(unsubscribeTerminalInput).toHaveBeenCalledTimes(1);
	});

	it("aborts and persists active runs before the runtime becomes stale", () => {
		const store = createStore();
		const abortController = new AbortController();
		const run = makeRun({ abortController });
		store.commandRuns.set(run.id, run);
		store.globalLiveRuns.set(run.id, {
			runState: run,
			abortController,
			originSessionFile: "/tmp/main.jsonl",
		});
		store.batchGroups.set("batch", {
			batchId: "batch",
			runIds: [run.id],
			completedRunIds: new Set(),
			failedRunIds: new Set(),
			originSessionFile: "/tmp/main.jsonl",
			createdAt: Date.now(),
			pendingResults: new Map(),
		});
		const pi = { sendMessage: vi.fn() };

		shutdownSubagentRuns(store, pi as never, "reload");

		expect(store.disposed).toBe(true);
		expect(abortController.signal.aborted).toBe(true);
		expect(run.status).toBe("error");
		expect(run.removed).toBe(true);
		expect(run.lastLine).toContain("session reload");
		expect(store.globalLiveRuns.size).toBe(0);
		expect(store.batchGroups.size).toBe(0);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "subagent-command",
				details: expect.objectContaining({ runId: 1, status: "error" }),
			}),
			expect.objectContaining({ deliverAs: "followUp", triggerTurn: false }),
		);
	});
});
