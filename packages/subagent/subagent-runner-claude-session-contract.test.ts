/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionReplayItems } from "./replay.ts";
import { runSingleAgent } from "./runner.ts";

const spawnMock = vi.hoisted(() => vi.fn());
const resolveClaudeRuntimeModeMock = vi.hoisted(() => vi.fn());

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

function makeClaudeAgent() {
	return {
		name: "claude-worker",
		description: "Claude worker",
		tools: ["read"],
		model: "claude-sonnet-4-6",
		thinking: "low" as const,
		systemPrompt: "Test prompt",
		source: "user" as const,
		filePath: "/tmp/claude-worker.md",
		runtime: "claude" as const,
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

function makeProcess(lines: string[], trailingNewline = true): MockProc {
	const proc = new EventEmitter() as MockProc;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.exitCode = null;
	proc.kill = vi.fn((signal?: string) => {
		proc.exitCode = signal === "SIGKILL" ? 137 : 0;
		return true;
	});

	queueMicrotask(() => {
		const output = `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
		proc.stdout.emit("data", Buffer.from(output, "utf8"));
		proc.exitCode = 0;
		proc.emit("exit", 0);
		proc.emit("close", 0);
	});

	return proc;
}

function makeAbortableProcess(lines: string[]): MockProc {
	const proc = new EventEmitter() as MockProc;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.exitCode = null;
	proc.kill = vi.fn((signal?: string) => {
		proc.exitCode = signal === "SIGKILL" ? 137 : 0;
		queueMicrotask(() => {
			proc.emit("exit", proc.exitCode);
			proc.emit("close", proc.exitCode);
		});
		return true;
	});

	queueMicrotask(() => {
		proc.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`, "utf8"));
	});

	return proc;
}

describe("runSingleAgent Claude session contract", () => {
	let tmpDir: string;
	let sidecarFile: string;

	beforeEach(() => {
		spawnMock.mockReset();
		resolveClaudeRuntimeModeMock.mockReset();
		resolveClaudeRuntimeModeMock.mockReturnValue("cli");
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runner-session-"));
		sidecarFile = path.join(tmpDir, "sidecar.jsonl");
	});

	afterEach(() => {
		vi.clearAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("continues a Claude run with separate resumeSessionId and sidecarSessionFile", async () => {
		spawnMock
			.mockImplementationOnce(() => makeProcess(makeClaudeLines("sess-initial", "first answer")))
			.mockImplementationOnce(() => makeProcess(makeClaudeLines("sess-initial", "continued answer")));

		const agents = [makeClaudeAgent()];

		const first = await runSingleAgent(
			"/tmp/project",
			agents,
			"claude-worker",
			"first task",
			undefined,
			undefined,
			undefined,
			makeDetails,
			{ sessionFile: sidecarFile, sidecarSessionFile: sidecarFile },
		);

		const second = await runSingleAgent(
			"/tmp/project",
			agents,
			"claude-worker",
			"continue task",
			undefined,
			undefined,
			undefined,
			makeDetails,
			{
				sessionFile: sidecarFile,
				resumeSessionId: "sess-initial",
				sidecarSessionFile: sidecarFile,
			},
		);

		expect(first.sessionFile).toBe(sidecarFile);
		expect(second.sessionFile).toBe(sidecarFile);
		expect(second.claudeSessionId).toBe("sess-initial");

		const firstSpawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
		const secondSpawnArgs = spawnMock.mock.calls[1]?.[1] as string[];
		expect(firstSpawnArgs).not.toContain("--resume");
		expect(secondSpawnArgs).toContain("--resume");
		expect(secondSpawnArgs).toContain("sess-initial");

		const replayItems = readSessionReplayItems(sidecarFile);
		expect(replayItems).toHaveLength(4);
		expect(replayItems[0]).toMatchObject({ type: "user", content: expect.stringContaining("first task") });
		expect(replayItems[1]).toMatchObject({ type: "assistant", content: expect.stringContaining("first answer") });
		expect(replayItems[2]).toMatchObject({ type: "user", content: expect.stringContaining("continue task") });
		expect(replayItems[3]).toMatchObject({ type: "assistant", content: expect.stringContaining("continued answer") });
		const raw = fs.readFileSync(sidecarFile, "utf8");
		expect(raw.match(/"type":"subagent_done"/g)?.length).toBe(2);
	});

	it("treats legacy string session config as a sidecar file path", async () => {
		spawnMock.mockImplementationOnce(() => makeProcess(makeClaudeLines("sess-path", "path answer")));

		const result = await runSingleAgent(
			"/tmp/project",
			[makeClaudeAgent()],
			"claude-worker",
			"task from path",
			undefined,
			undefined,
			undefined,
			makeDetails,
			sidecarFile,
		);

		const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
		expect(spawnArgs).not.toContain("--resume");
		expect(result.sessionFile).toBe(sidecarFile);

		const replayItems = readSessionReplayItems(sidecarFile);
		expect(replayItems).toHaveLength(2);
		expect(replayItems[0]?.content).toContain("task from path");
		expect(replayItems[1]?.content).toContain("path answer");
	});

	it("keeps legacy UUID session config as resume-only input for backward compatibility", async () => {
		spawnMock.mockImplementationOnce(() => makeProcess(makeClaudeLines("sess-legacy", "legacy answer")));

		const resumeId = "f110cdeb-3b75-4dd8-a8f8-f09d762ef971";
		const result = await runSingleAgent(
			"/tmp/project",
			[makeClaudeAgent()],
			"claude-worker",
			"legacy continue",
			undefined,
			undefined,
			undefined,
			makeDetails,
			resumeId,
		);

		const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
		expect(spawnArgs).toContain("--resume");
		expect(spawnArgs).toContain(resumeId);
		expect(result.sessionFile).toBeUndefined();
	});

	it("persists a non-zero completion marker for an unterminated error result", async () => {
		spawnMock.mockImplementationOnce(() =>
			makeProcess(
				[
					JSON.stringify({
						type: "system",
						subtype: "init",
						session_id: "sess-error",
						model: "claude-sonnet-4-6",
						cwd: "/tmp/project",
					}),
					JSON.stringify({
						type: "result",
						subtype: "error_during_execution",
						session_id: "sess-error",
						is_error: true,
						stop_reason: "error",
						result: "boom",
					}),
				],
				false,
			),
		);

		const result = await runSingleAgent(
			"/tmp/project",
			[makeClaudeAgent()],
			"claude-worker",
			"fail without newline",
			undefined,
			undefined,
			undefined,
			makeDetails,
			{ sessionFile: sidecarFile, sidecarSessionFile: sidecarFile },
		);

		expect(result.exitCode).toBe(1);
		const done = fs
			.readFileSync(sidecarFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.find((entry) => entry.type === "subagent_done");
		expect(done).toMatchObject({ exitCode: 1, stopReason: "error" });
	});

	it("writes aborted marker with non-zero exitCode on signal abort", async () => {
		spawnMock.mockImplementationOnce(() =>
			makeAbortableProcess([
				JSON.stringify({
					type: "system",
					subtype: "init",
					session_id: "sess-abort",
					model: "claude-sonnet-4-6",
					cwd: "/tmp/project",
				}),
			]),
		);
		const ac = new AbortController();

		const resultPromise = runSingleAgent(
			"/tmp/project",
			[makeClaudeAgent()],
			"claude-worker",
			"abort me",
			undefined,
			ac.signal,
			undefined,
			makeDetails,
			{ sessionFile: sidecarFile, sidecarSessionFile: sidecarFile },
		);

		ac.abort();
		await expect(resultPromise).rejects.toThrow("Subagent was aborted");

		const raw = fs.readFileSync(sidecarFile, "utf8");
		expect(raw).toContain('"type":"subagent_done"');
		expect(raw).toContain('"exitCode":1');
		expect(raw).toContain('"stopReason":"aborted"');
	});
});
