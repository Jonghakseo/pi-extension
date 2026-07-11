import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkRunnerMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const resolveClaudeRuntimeModeMock = vi.hoisted(() => vi.fn());

vi.mock("./claude-sdk-runner.js", () => ({
	runClaudeAgentViaSdk: sdkRunnerMock,
}));

vi.mock("./config.js", () => ({
	resolveClaudeRuntimeMode: (...args: unknown[]) => resolveClaudeRuntimeModeMock(...args),
}));

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

type MockProc = EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	exitCode: number | null;
	kill: ReturnType<typeof vi.fn>;
};

function makeClaudeProcess(lines: string[]): MockProc {
	const proc = new EventEmitter() as MockProc;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.exitCode = null;
	proc.kill = vi.fn(() => true);

	queueMicrotask(() => {
		proc.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`, "utf8"));
		proc.exitCode = 0;
		proc.emit("exit", 0);
		proc.emit("close", 0);
	});

	return proc;
}

function makeClaudeLines(sessionId: string, text: string): string[] {
	return [
		JSON.stringify({
			type: "system",
			subtype: "init",
			session_id: sessionId,
			model: "claude-sonnet-4-6",
			cwd: "/tmp/project",
		}),
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				model: "claude-sonnet-4-6",
				content: [{ type: "text", text }],
			},
		}),
		JSON.stringify({
			type: "result",
			session_id: sessionId,
			is_error: false,
			stop_reason: "end_turn",
			result: text,
			usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			total_cost_usd: 0.001,
			num_turns: 1,
			permission_denials: [],
		}),
	];
}

describe("runSingleAgent SDK dispatch", () => {
	beforeEach(() => {
		sdkRunnerMock.mockReset();
		spawnMock.mockReset();
		resolveClaudeRuntimeModeMock.mockReset();
		resolveClaudeRuntimeModeMock.mockReturnValue("sdk");
		vi.resetModules();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("uses runClaudeAgentViaSdk when config resolves to sdk", async () => {
		sdkRunnerMock.mockResolvedValue({
			agent: "worker",
			agentSource: "project",
			task: "do work",
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			runtime: "claude",
		});

		const { runSingleAgent } = await import("./runner.ts");
		const result = await runSingleAgent(
			"/tmp/project",
			[
				{
					name: "worker",
					description: "Worker",
					tools: ["read"],
					model: "claude-sonnet-4-6",
					systemPrompt: "Follow instructions.",
					source: "project",
					filePath: "/tmp/worker.md",
					runtime: "claude",
				},
			],
			"worker",
			"do work",
			undefined,
			undefined,
			undefined,
			(results) => ({ mode: "single", inheritMainContext: false, projectAgentsDir: null, results }),
			{ sidecarSessionFile: "/tmp/project/sidecar.jsonl" },
		);

		expect(result.exitCode).toBe(0);
		expect(sdkRunnerMock).toHaveBeenCalledTimes(1);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("falls back to Claude CLI when config resolves to cli", async () => {
		resolveClaudeRuntimeModeMock.mockReturnValue("cli");
		spawnMock.mockImplementationOnce(() => makeClaudeProcess(makeClaudeLines("sess-cli", "cli answer")));

		const { runSingleAgent } = await import("./runner.ts");
		const result = await runSingleAgent(
			"/tmp/project",
			[
				{
					name: "worker",
					description: "Worker",
					tools: ["read"],
					model: "claude-sonnet-4-6",
					systemPrompt: "Follow instructions.",
					source: "project",
					filePath: "/tmp/worker.md",
					runtime: "claude",
				},
			],
			"worker",
			"do work",
			undefined,
			undefined,
			undefined,
			(results) => ({ mode: "single", inheritMainContext: false, projectAgentsDir: null, results }),
		);

		expect(result.exitCode).toBe(0);
		expect(result.claudeSessionId).toBe("sess-cli");
		expect(result.messages[0]?.role).toBe("assistant");
		expect(sdkRunnerMock).not.toHaveBeenCalled();
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});
});
