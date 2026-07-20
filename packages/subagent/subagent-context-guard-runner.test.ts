/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function makeCodexAgent(model: string) {
	return {
		name: "pi-worker",
		description: "PI worker",
		systemPrompt: "Test prompt",
		source: "user" as const,
		filePath: "/tmp/pi-worker.md",
		runtime: "pi" as const,
		model,
	};
}

function makeDetails(results: any[]) {
	return { mode: "single" as const, inheritMainContext: false, projectAgentsDir: null, results };
}

/** Process that emits the given stdout lines, and on kill() emits exit/close so the run settles. */
function makeGuardProcess(lines: string[], autoComplete: boolean): MockProc {
	const proc = new EventEmitter() as MockProc;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.exitCode = null;
	proc.kill = vi.fn((signal?: string) => {
		if (proc.exitCode === null) proc.exitCode = signal === "SIGKILL" ? 137 : 0;
		queueMicrotask(() => {
			proc.emit("exit", proc.exitCode);
			proc.emit("close", proc.exitCode);
		});
		return true;
	});
	queueMicrotask(() => {
		proc.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`, "utf8"));
		if (autoComplete) {
			proc.exitCode = 0;
			proc.emit("exit", 0);
			proc.emit("close", 0);
		}
	});
	return proc;
}

function assistantMessageEnd(model: string, stopReason: string, totalTokens: number): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			model,
			content: [{ type: "text", text: "partial finding" }],
			stopReason,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens },
		},
	});
}

async function run(agentModel: string, lines: string[], autoComplete: boolean) {
	const { runSingleAgent } = await import("./runner.ts");
	const proc = makeGuardProcess(lines, autoComplete);
	spawnMock.mockImplementationOnce(() => proc);
	const result = await runSingleAgent(
		"/tmp/project",
		[makeCodexAgent(agentModel)],
		"pi-worker",
		"heavy task",
		undefined,
		undefined,
		undefined,
		makeDetails,
	);
	return { result, proc };
}

afterEach(() => {
	spawnMock.mockReset();
});

describe("runPiAgent proactive context guard", () => {
	it("trips on a GPT-5.6 toolUse turn once peak tokens cross the ceiling", async () => {
		const model = "openai-codex/gpt-5.6-sol";
		const { result, proc } = await run(
			model,
			[JSON.stringify({ type: "agent_start" }), assistantMessageEnd(model, "toolUse", 340_000)],
			false,
		);

		expect(result.stopReason).toBe("error");
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("context guard:");
		expect(result.errorMessage).toContain("340000");
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("does not trip on a terminal stop message even at high token counts", async () => {
		const model = "openai-codex/gpt-5.6-sol";
		const { result } = await run(
			model,
			[JSON.stringify({ type: "agent_start" }), assistantMessageEnd(model, "stop", 340_000)],
			true,
		);

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage ?? "").not.toContain("context guard:");
	});

	it("trips for GPT-5.3 Codex Spark at its 115k ceiling", async () => {
		const model = "openai-codex/gpt-5.3-codex-spark";
		const { result, proc } = await run(
			model,
			[JSON.stringify({ type: "agent_start" }), assistantMessageEnd(model, "toolUse", 115_000)],
			false,
		);

		expect(result.stopReason).toBe("error");
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("context guard:");
		expect(result.errorMessage).toContain("115000");
		expect(result.errorClass).toBe("context_overflow");
		expect(result.peakContextTokens).toBe(115_000);
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("records peak context, failure class, and the last tool result", async () => {
		const model = "openai-codex/gpt-5.3-codex-spark";
		const errorMessage = "Codex error: Our servers are currently overloaded. Please try again later.";
		const { result } = await run(
			model,
			[
				JSON.stringify({ type: "agent_start" }),
				assistantMessageEnd(model, "toolUse", 80_000),
				JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/tmp/a.ts" } }),
				JSON.stringify({
					type: "tool_result_end",
					message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "123456789" }] },
				}),
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model,
						content: [],
						stopReason: "error",
						errorMessage,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					},
				}),
			],
			true,
		);

		expect(result.errorClass).toBe("overloaded");
		expect(result.peakContextTokens).toBe(80_000);
		expect(result.lastToolName).toBe("read");
		expect(result.lastToolOutputChars).toBe(9);
	});
});
