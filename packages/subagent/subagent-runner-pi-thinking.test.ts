/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

type MockProc = EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	exitCode: number | null;
	kill: ReturnType<typeof vi.fn>;
};

function makePiAgent() {
	return {
		name: "pi-worker",
		description: "PI worker",
		systemPrompt: "Test prompt",
		source: "user" as const,
		filePath: "/tmp/pi-worker.md",
		runtime: "pi" as const,
	};
}

function makeDetails(results: any[]) {
	return {
		mode: "single" as const,
		inheritMainContext: false,
		projectAgentsDir: null,
		results,
	};
}

function makeHangingProcess(lines: string[]): MockProc {
	const proc = new EventEmitter() as MockProc;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.exitCode = null;
	proc.kill = vi.fn((signal?: string) => {
		proc.exitCode = signal === "SIGKILL" ? 137 : 0;
		return true;
	});

	queueMicrotask(() => {
		proc.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`, "utf8"));
	});

	return proc;
}

function makeCompletedProcess(lines: string[]): MockProc {
	const proc = makeHangingProcess(lines);
	queueMicrotask(() => {
		proc.exitCode = 0;
		proc.emit("exit", 0);
		proc.emit("close", 0);
	});
	return proc;
}

function makeHangingProcessWithDelayedEvent(lines: string[], delayedLine: string, delayMs: number): MockProc {
	const proc = makeHangingProcess(lines);
	setTimeout(() => {
		proc.stdout.emit("data", Buffer.from(`${delayedLine}\n`, "utf8"));
	}, delayMs);
	return proc;
}

function makeAbortableProcess(lines: string[]): MockProc {
	const proc = makeHangingProcess(lines);
	proc.kill = vi.fn((signal?: string) => {
		proc.exitCode = signal === "SIGKILL" ? 137 : 0;
		queueMicrotask(() => {
			proc.emit("exit", proc.exitCode);
			proc.emit("close", proc.exitCode);
		});
		return true;
	});
	return proc;
}

describe("runSingleAgent pi live preview parity", () => {
	it("surfaces tool execution previews using Claude-style liveActivityPreview flow", async () => {
		const { runSingleAgent } = await import("./runner.ts");
		const updates: any[] = [];
		spawnMock.mockImplementationOnce(() =>
			makeCompletedProcess([
				JSON.stringify({ type: "agent_start" }),
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "read",
					args: { path: "/tmp/payment-details.md", offset: 3, limit: 5 },
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "test-model",
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop",
					},
				}),
			]),
		);

		await runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			(partial) => updates.push(partial.details.results[0]),
			makeDetails,
		);

		expect(updates.some((result) => result.liveActivityPreview === "→ read /tmp/payment-details.md:3-7")).toBe(true);
	});

	it("sanitizes thinking deltas like Claude runtime before showing thoughtText", async () => {
		const { runSingleAgent } = await import("./runner.ts");
		const updates: any[] = [];
		spawnMock.mockImplementationOnce(() =>
			makeCompletedProcess([
				JSON.stringify({ type: "agent_start" }),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: {
						type: "thinking_delta",
						delta: "## **Searching** `payment` details\nMore context",
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "test-model",
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop",
					},
				}),
			]),
		);

		const result = await runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			(partial) => updates.push(partial.details.results[0]),
			makeDetails,
		);

		expect(updates.some((partial) => partial.thoughtText === "Searching payment details")).toBe(true);
		expect(result.thoughtText).toBe("Searching payment details");
	});

	it("updates liveActivityPreview from streaming text deltas", async () => {
		const { runSingleAgent } = await import("./runner.ts");
		const updates: any[] = [];
		spawnMock.mockImplementationOnce(() =>
			makeCompletedProcess([
				JSON.stringify({ type: "agent_start" }),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: {
						type: "text_delta",
						delta: "Line 1\nLine 2",
					},
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "test-model",
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop",
					},
				}),
			]),
		);

		await runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			(partial) => updates.push(partial.details.results[0]),
			makeDetails,
		);

		expect(updates.some((partial) => partial.liveActivityPreview === "Line 2")).toBe(true);
	});

	it("uses accumulated text when a single live line arrives across multiple text_delta chunks", async () => {
		const { runSingleAgent } = await import("./runner.ts");
		const updates: any[] = [];
		spawnMock.mockImplementationOnce(() =>
			makeCompletedProcess([
				JSON.stringify({ type: "agent_start" }),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "Hello " },
				}),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "world" },
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "test-model",
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop",
					},
				}),
			]),
		);

		await runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			(partial) => updates.push(partial.details.results[0]),
			makeDetails,
		);

		expect(updates.some((partial) => partial.liveActivityPreview === "Hello world")).toBe(true);
	});

	it("updates thoughtText from accumulated thinking chunks instead of keeping the first partial chunk", async () => {
		const { runSingleAgent } = await import("./runner.ts");
		const updates: any[] = [];
		spawnMock.mockImplementationOnce(() =>
			makeCompletedProcess([
				JSON.stringify({ type: "agent_start" }),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", delta: "## **Sear" },
				}),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", delta: "ching** `payment` details" },
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "test-model",
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop",
					},
				}),
			]),
		);

		const result = await runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			(partial) => updates.push(partial.details.results[0]),
			makeDetails,
		);

		expect(updates.some((partial) => partial.thoughtText === "Searching payment details")).toBe(true);
		expect(result.thoughtText).toBe("Searching payment details");
	});

	it("resets thought accumulation at turn boundaries", async () => {
		const { runSingleAgent } = await import("./runner.ts");
		const updates: any[] = [];
		spawnMock.mockImplementationOnce(() =>
			makeCompletedProcess([
				JSON.stringify({ type: "agent_start" }),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", delta: "First turn thought" },
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "test-model",
						content: [{ type: "text", text: "intermediate" }],
						stopReason: "toolUse",
					},
				}),
				JSON.stringify({ type: "turn_start" }),
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", delta: "Second turn thought" },
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "test-model",
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop",
					},
				}),
			]),
		);

		const result = await runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			(partial) => updates.push(partial.details.results[0]),
			makeDetails,
		);

		expect(updates.some((partial) => partial.thoughtText === "Second turn thought")).toBe(true);
		expect(result.thoughtText).toBe("Second turn thought");
	});
});

describe("runSingleAgent pi terminal message fallback", () => {
	let tmpDir: string;
	let sessionFile: string;

	beforeEach(() => {
		spawnMock.mockReset();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-session-"));
		sessionFile = path.join(tmpDir, "session.jsonl");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("force-resolves after a terminal assistant message even if the pi child never exits", async () => {
		vi.useFakeTimers();
		const { runSingleAgent } = await import("./runner.ts");
		spawnMock.mockImplementationOnce(() =>
			makeHangingProcess([
				JSON.stringify({ type: "agent_start" }),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "test-model",
						content: [{ type: "text", text: "Final answer" }],
						stopReason: "stop",
					},
				}),
			]),
		);

		const resultPromise = runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			undefined,
			makeDetails,
		);

		await vi.runAllTicks();
		await vi.advanceTimersByTimeAsync(3000);
		const result = await resultPromise;
		await vi.runOnlyPendingTimersAsync();

		expect(result.exitCode).toBe(0);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.role).toBe("assistant");
		expect(spawnMock).toHaveBeenCalledTimes(1);
		const proc = spawnMock.mock.results[0]?.value as MockProc;
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("still force-resolves when cleanup events arrive after the terminal assistant message", async () => {
		vi.useFakeTimers();
		const { runSingleAgent } = await import("./runner.ts");
		spawnMock.mockImplementationOnce(() =>
			makeHangingProcessWithDelayedEvent(
				[
					JSON.stringify({ type: "agent_start" }),
					JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							model: "test-model",
							content: [{ type: "text", text: "Final answer" }],
							stopReason: "stop",
						},
					}),
				],
				JSON.stringify({ type: "cleanup_event" }),
				1000,
			),
		);

		const resultPromise = runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			undefined,
			makeDetails,
		);

		await vi.runAllTicks();
		await vi.advanceTimersByTimeAsync(3000);
		const result = await resultPromise;
		await vi.runOnlyPendingTimersAsync();

		expect(result.exitCode).toBe(0);
		expect(result.messages).toHaveLength(1);
		const proc = spawnMock.mock.results[0]?.value as MockProc;
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("ignores stale terminal entries that predate the current invocation", async () => {
		vi.useFakeTimers();
		const { runSingleAgent } = await import("./runner.ts");
		fs.writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				timestamp: Date.now(),
				message: {
					role: "assistant",
					stopReason: "stop",
					timestamp: Date.now(),
					content: [{ type: "text", text: "old answer" }],
				},
			})}\n${JSON.stringify({ type: "subagent_done", timestamp: Date.now(), exitCode: 0, stopReason: "stop", runtime: "pi" })}\n`,
			"utf8",
		);
		const baseOffset = fs.statSync(sessionFile).size;
		spawnMock.mockImplementationOnce(() => makeHangingProcess([JSON.stringify({ type: "agent_start" })]));

		const resultPromise = runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"new task",
			undefined,
			undefined,
			undefined,
			makeDetails,
			{ sessionFile, persistedSessionBaseOffset: baseOffset },
		);

		await vi.runAllTicks();
		await vi.advanceTimersByTimeAsync(1500);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		const proc = spawnMock.mock.results[0]?.value as MockProc;
		expect(proc.kill).not.toHaveBeenCalled();

		setTimeout(() => {
			fs.appendFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "message",
					timestamp: Date.now(),
					message: {
						role: "assistant",
						stopReason: "stop",
						timestamp: Date.now(),
						content: [{ type: "text", text: "new answer" }],
					},
				})}\n`,
				"utf8",
			);
		}, 100);
		await vi.advanceTimersByTimeAsync(1200);
		const result = await resultPromise;
		await vi.runOnlyPendingTimersAsync();

		expect((result.messages.at(-1)?.content[0] as any)?.text).toContain("new answer");
	});

	it("recovers completion from the persisted session file when stdout never delivers the final message", async () => {
		vi.useFakeTimers();
		const { runSingleAgent } = await import("./runner.ts");
		spawnMock.mockImplementationOnce(() => makeHangingProcess([JSON.stringify({ type: "agent_start" })]));

		const resultPromise = runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"review task",
			undefined,
			undefined,
			undefined,
			makeDetails,
			sessionFile,
		);

		await vi.runAllTicks();
		setTimeout(() => {
			fs.writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "message",
					timestamp: Date.now(),
					message: {
						role: "assistant",
						stopReason: "stop",
						timestamp: Date.now(),
						content: [{ type: "text", text: "Recovered from session file" }],
					},
				})}\n`,
				"utf8",
			);
		}, 500);

		await vi.advanceTimersByTimeAsync(1200);
		const result = await resultPromise;
		await vi.runOnlyPendingTimersAsync();

		expect(result.exitCode).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(result.messages.at(-1)?.role).toBe("assistant");
		expect((result.messages.at(-1)?.content[0] as any)?.text).toContain("Recovered from session file");
		const proc = spawnMock.mock.results[0]?.value as MockProc;
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		const persisted = fs.readFileSync(sessionFile, "utf8");
		expect(persisted).toContain('"type":"subagent_done"');
	});

	it("writes aborted marker with non-zero exitCode on signal abort", async () => {
		vi.useFakeTimers();
		const { runSingleAgent } = await import("./runner.ts");
		spawnMock.mockImplementationOnce(() => makeAbortableProcess([JSON.stringify({ type: "agent_start" })]));
		const ac = new AbortController();

		const resultPromise = runSingleAgent(
			"/tmp/project",
			[makePiAgent()],
			"pi-worker",
			"abort me",
			undefined,
			ac.signal,
			undefined,
			makeDetails,
			sessionFile,
		);
		const rejection = resultPromise.catch((error) => error);

		await vi.runAllTicks();
		ac.abort();
		await vi.runOnlyPendingTimersAsync();
		const error = await rejection;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Subagent was aborted");

		const persisted = fs.readFileSync(sessionFile, "utf8");
		expect(persisted).toContain('"type":"subagent_done"');
		expect(persisted).toContain('"exitCode":1');
		expect(persisted).toContain('"stopReason":"aborted"');
	});
});
