/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentExtension from "./index.ts";
import { shutdownSubagentRuns } from "./lifecycle.ts";
import { SUBAGENT_COMMANDS, SUBAGENT_SHORTCUTS } from "./registration-manifest.ts";
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

		// Commands and shortcut documentation must exist before the deferred core load,
		// otherwise Pi omits them from initial autocomplete and /hotkeys snapshots.
		expect(pi.registerCommand.mock.calls.map(([name]) => name)).toEqual(Object.keys(SUBAGENT_COMMANDS));
		expect(pi.registerShortcut.mock.calls.map(([name]) => name)).toEqual(Object.keys(SUBAGENT_SHORTCUTS));

		// Factory schedules one deferred background-load timer; fire it.
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(pi.registerCommand).toHaveBeenCalledTimes(Object.keys(SUBAGENT_COMMANDS).length);
		expect(pi.registerShortcut).toHaveBeenCalledTimes(Object.keys(SUBAGENT_SHORTCUTS).length);

		const unsubscribeTerminalInput = vi.fn();
		const readinessOrder: string[] = [];
		const ctx = {
			cwd: "/tmp/project",
			hasUI: false,
			ui: {
				onTerminalInput: vi.fn(() => {
					readinessOrder.push("session-ready");
					return unsubscribeTerminalInput;
				}),
				notify: vi.fn(() => readinessOrder.push("command-ran")),
				setWidget: vi.fn(),
			},
			sessionManager: { getSessionFile: () => "/tmp/main.jsonl", getEntries: () => [] },
		};
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, ctx);
		}
		expect(vi.getTimerCount()).toBe(1);

		const peekCommand = pi.registerCommand.mock.calls.find(([name]) => name === "sub:peek")?.[1];
		expect(await peekCommand.getArgumentCompletions("")).toBeNull();
		await peekCommand.handler("", ctx);
		expect(readinessOrder).toEqual(["session-ready", "command-ran"]);

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
