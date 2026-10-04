/** biome-ignore-all lint/suspicious/noExplicitAny: tests exercise dynamic subprocess JSON events. */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "./agents.ts";
import type { RunnerDiagnosticEvent } from "./diagnostics.ts";
import { invokeWithAutoRetry } from "./retry.ts";
import { getFinalOutput, runSingleAgent } from "./runner.ts";
import type { SingleResult, SubagentDetails } from "./types.ts";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

const agent: AgentConfig = {
	name: "worker",
	description: "Retry test worker",
	systemPrompt: "",
	source: "user",
	filePath: "/tmp/worker.md",
	runtime: "pi",
};
const makeDetails = (results: SingleResult[]): SubagentDetails => ({
	mode: "single",
	inheritMainContext: false,
	projectAgentsDir: null,
	results,
});
const assistant = (stopReason: string, errorMessage?: string) => ({
	role: "assistant",
	content: stopReason === "error" ? [] : [{ type: "text", text: "Recovered" }],
	stopReason,
	errorMessage,
	usage: { input: 0, output: 0, totalTokens: 0 },
});

function makeChild() {
	const proc = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		exitCode: null as number | null,
		kill: vi.fn((_signal: string) => true),
	});
	const emit = (event: object) => proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
	const close = (code = 0) => {
		proc.exitCode = code;
		proc.emit("exit", code, null);
		proc.emit("close", code, null);
	};
	proc.kill.mockImplementation(() => {
		queueMicrotask(() => close(1));
		return true;
	});
	return { proc, emit, close };
}

let tmpDir: string;
let sessionFile: string;
let diagnostics: RunnerDiagnosticEvent[];
const persist = (message: object) =>
	fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message, timestamp: Date.now() })}\n`);
const markers = () =>
	fs
		.readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((entry) => entry.type === "subagent_done");
const run = (signal?: AbortSignal) =>
	runSingleAgent(tmpDir, [agent], "worker", "retry task", undefined, signal, undefined, makeDetails, {
		sessionFile,
		onDiagnostic: (event) => diagnostics.push(event),
	});

beforeEach(() => {
	spawnMock.mockReset();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-internal-retry-"));
	sessionFile = path.join(tmpDir, "session.jsonl");
	fs.writeFileSync(sessionFile, "");
	diagnostics = [];
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Pi internal retry lifecycle", () => {
	it("allows a real child to recover after backoff without an outer restart or premature marker", async () => {
		const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		const fixture = fileURLToPath(new URL("./fixtures/pi-internal-retry.mjs", import.meta.url));
		spawnMock.mockImplementation((_command, args, options) => spawn(process.execPath, [fixture, ...args], options));
		const { result, retryCount } = await invokeWithAutoRetry({ invoke: () => run(), maxRetries: 1 });
		expect(result.exitCode).toBe(0);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.errorClass).toBeUndefined();
		expect(getFinalOutput(result.messages)).toBe("Recovered in the same child");
		expect(retryCount).toBe(0);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(diagnostics.filter((event) => event.event === "kill_intent")).toEqual([]);
		expect(markers()).toEqual([expect.objectContaining({ exitCode: 0, stopReason: "stop" })]);
	}, 20_000);

	it.each([
		true,
		false,
	])("does not finish when persisted error precedes stdout (message_end delivered: %s)", async (deliverMessageEnd) => {
		vi.useFakeTimers();
		const child = makeChild();
		spawnMock.mockReturnValue(child.proc);
		const promise = run();
		const error = assistant("error", "Connection error.");
		persist(error);
		// Poll wins the race, before stdout says whether this is final or retryable.
		await vi.advanceTimersByTimeAsync(1100);
		expect(child.proc.kill).not.toHaveBeenCalled();
		expect(markers()).toEqual([]);
		if (deliverMessageEnd) child.emit({ type: "message_end", message: error });
		child.emit({ type: "agent_end", messages: [error], willRetry: true });
		child.emit({ type: "auto_retry_start", attempt: 1, delayMs: 3000 });
		await vi.advanceTimersByTimeAsync(4000);
		expect(child.proc.kill).not.toHaveBeenCalled();
		expect(markers()).toEqual([]);
		child.emit({ type: "agent_start" });
		child.emit({ type: "turn_start" });
		// The next successful tool turn ends recovery, but raw history still has the error.
		const toolMessage = assistant("toolUse");
		persist(toolMessage);
		child.emit({ type: "message_end", message: toolMessage });
		child.emit({ type: "auto_retry_end", success: true, attempt: 1 });
		await vi.advanceTimersByTimeAsync(4000);
		expect(child.proc.kill).not.toHaveBeenCalled();
		expect(markers()).toEqual([]);
		const success = assistant("stop");
		persist(success);
		child.emit({ type: "message_end", message: success });
		child.emit({ type: "agent_end", messages: [toolMessage, success], willRetry: false });
		child.close();
		const result = await promise;
		expect(result.exitCode).toBe(0);
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(markers()).toEqual([expect.objectContaining({ exitCode: 0, stopReason: "stop" })]);
	});

	it("honors auto_retry_start when older Pi agent_end omits willRetry", async () => {
		vi.useFakeTimers();
		const child = makeChild();
		spawnMock.mockReturnValue(child.proc);
		const promise = run();
		const error = assistant("error", "Connection error.");
		persist(error);
		child.emit({ type: "message_end", message: error });
		child.emit({ type: "agent_end", messages: [error] });
		child.emit({ type: "auto_retry_start", attempt: 1, delayMs: 3000 });
		await vi.advanceTimersByTimeAsync(4000);
		expect(child.proc.kill).not.toHaveBeenCalled();
		expect(markers()).toEqual([]);
		// Recovery also works if stdout omits the successful message_end.
		const success = assistant("stop");
		persist(success);
		child.emit({ type: "auto_retry_end", success: true, attempt: 1 });
		expect(markers()).toEqual([]);
		child.emit({ type: "agent_end", messages: [success], willRetry: false });
		child.close();
		const result = await promise;
		expect(result.exitCode).toBe(0);
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(markers()).toEqual([expect.objectContaining({ exitCode: 0, stopReason: "stop" })]);
	});

	it("waits through multiple retries and only completes on final exhaustion", async () => {
		vi.useFakeTimers();
		const child = makeChild();
		spawnMock.mockReturnValue(child.proc);
		const promise = run();
		for (let attempt = 1; attempt <= 3; attempt++) {
			child.emit({ type: "agent_start" });
			const error = assistant("error", `Connection error. attempt ${attempt}`);
			persist(error);
			child.emit({ type: "message_end", message: error });
			child.emit({ type: "agent_end", messages: [error], willRetry: true });
			child.emit({ type: "auto_retry_start", attempt, delayMs: 5000 });
			await vi.advanceTimersByTimeAsync(6000);
			expect(child.proc.kill).not.toHaveBeenCalled();
			expect(markers()).toEqual([]);
		}
		child.emit({ type: "agent_start" });
		const finalError = assistant("error", "Request timed out.");
		persist(finalError);
		child.emit({ type: "message_end", message: finalError });
		child.emit({ type: "agent_end", messages: [finalError], willRetry: false });
		child.emit({ type: "auto_retry_end", success: false, attempt: 3, finalError: finalError.errorMessage });
		await vi.advanceTimersByTimeAsync(2000);
		const result = await promise;
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toBe("Request timed out.");
		expect(markers()).toEqual([expect.objectContaining({ exitCode: 1, stopReason: "error" })]);
	});

	it("cleans up a hanging child after a final non-retryable error", async () => {
		vi.useFakeTimers();
		const child = makeChild();
		spawnMock.mockReturnValue(child.proc);
		const promise = run();
		const error = assistant("error", "Invalid API key");
		child.emit({ type: "message_end", message: error });
		child.emit({ type: "agent_end", messages: [error], willRetry: false });
		await vi.advanceTimersByTimeAsync(2000);
		expect((await promise).exitCode).toBe(1);
		expect(child.proc.kill).toHaveBeenCalledWith("SIGTERM");
		expect(markers()).toEqual([expect.objectContaining({ exitCode: 1, stopReason: "error" })]);
	});

	it("aborts immediately during Pi backoff without an outer retry", async () => {
		vi.useFakeTimers();
		const child = makeChild();
		spawnMock.mockReturnValue(child.proc);
		const ac = new AbortController();
		const promise = invokeWithAutoRetry({ invoke: () => run(ac.signal), signal: ac.signal });
		const rejection = promise.catch((error) => error);
		const error = assistant("error", "Connection error.");
		persist(error);
		child.emit({ type: "message_end", message: error });
		child.emit({ type: "agent_end", messages: [error], willRetry: true });
		child.emit({ type: "auto_retry_start", attempt: 1, delayMs: 30_000 });
		ac.abort();
		expect(child.proc.kill).toHaveBeenCalledWith("SIGTERM");
		await vi.advanceTimersByTimeAsync(1);
		expect(await rejection).toBeInstanceOf(Error);
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(markers()).toEqual([expect.objectContaining({ exitCode: 1, stopReason: "aborted" })]);
	});

	it("resolves from actual exit even if child pipes remain open during recovery", async () => {
		vi.useFakeTimers();
		const child = makeChild();
		spawnMock.mockReturnValue(child.proc);
		const promise = run();
		const error = assistant("error", "Connection error.");
		child.emit({ type: "message_end", message: error });
		child.emit({ type: "agent_end", messages: [error], willRetry: true });
		child.emit({ type: "auto_retry_start", attempt: 1, delayMs: 3000 });
		child.proc.exitCode = 1;
		child.proc.emit("exit", 1, null);
		await vi.advanceTimersByTimeAsync(1500);
		expect((await promise).exitCode).toBe(1);
		expect(child.proc.kill).not.toHaveBeenCalled();
		expect(markers()).toEqual([expect.objectContaining({ exitCode: 1, stopReason: "error" })]);
	});
});
