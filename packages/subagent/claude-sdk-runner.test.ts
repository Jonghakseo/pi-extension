/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	AbortError: class AbortError extends Error {},
	query: queryMock,
}));

function makeQuery(messages: any[]) {
	async function* iterator() {
		for (const message of messages) {
			yield message;
		}
	}

	const stream = iterator();
	return Object.assign(stream, { close: vi.fn() });
}

describe("runClaudeAgentViaSdk", () => {
	let sidecarDir: string;
	let sidecarFile: string;

	beforeEach(() => {
		sidecarDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sdk-runner-"));
		sidecarFile = path.join(sidecarDir, "sidecar.jsonl");
		queryMock.mockReset();
	});

	afterEach(() => {
		fs.rmSync(sidecarDir, { recursive: true, force: true });
	});

	it("returns Claude-style SingleResult for successful SDK runs and writes sidecar entries", async () => {
		queryMock.mockReturnValue(
			makeQuery([
				{
					type: "assistant",
					session_id: "sess-success",
					uuid: "assistant-1",
					parent_tool_use_id: null,
					message: {
						role: "assistant",
						model: "claude-sonnet-4-6",
						content: [{ type: "text", text: "SDK answer" }],
						stop_reason: "end_turn",
						usage: { input_tokens: 4, output_tokens: 2 },
					},
				},
				{
					type: "result",
					session_id: "sess-success",
					uuid: "result-1",
					is_error: false,
					stop_reason: "end_turn",
					result: "done",
					usage: { input_tokens: 4, output_tokens: 2 },
					num_turns: 1,
				},
			]),
		);

		const { runClaudeAgentViaSdk } = await import("./claude-sdk-runner.ts");
		const result = await runClaudeAgentViaSdk(
			"/tmp/project",
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
			"do work",
			2,
			undefined,
			undefined,
			(results) => ({ mode: "single", inheritMainContext: false, projectAgentsDir: null, results }),
			undefined,
			sidecarFile,
		);

		expect(result.exitCode).toBe(0);
		expect(result.runtime).toBe("claude");
		expect(result.claudeSessionId).toBe("sess-success");
		expect(result.sessionFile).toBe(sidecarFile);
		expect(result.claudeProjectDir).toBe("/tmp/project");
		expect(result.messages).toHaveLength(1);
		expect(queryMock).toHaveBeenCalledTimes(1);
		expect(queryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "do work",
				options: expect.objectContaining({
					tools: ["Read"],
					allowedTools: ["Read"],
				}),
			}),
		);
		expect(fs.existsSync(sidecarFile)).toBe(true);

		const lines = fs
			.readFileSync(sidecarFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatchObject({ type: "message", message: { role: "user" } });
		expect(lines[1]).toMatchObject({ type: "message", message: { role: "assistant" } });
		expect(lines[2]).toMatchObject({ type: "subagent_done", exitCode: 0, runtime: "claude" });
	});

	it("returns an error result for unsupported Claude runtime tools", async () => {
		const { runClaudeAgentViaSdk } = await import("./claude-sdk-runner.ts");
		const result = await runClaudeAgentViaSdk(
			"/tmp/project",
			{
				name: "worker",
				description: "Worker",
				tools: ["read", "ask_master", "memory_list"],
				model: "claude-sonnet-4-6",
				systemPrompt: "Follow instructions.",
				source: "project",
				filePath: "/tmp/worker.md",
				runtime: "claude",
			},
			"need approval",
			undefined,
			undefined,
			undefined,
			(results) => ({ mode: "single", inheritMainContext: false, projectAgentsDir: null, results }),
			undefined,
			sidecarFile,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unsupported tool "ask_master" for Claude runtime');
		expect(queryMock).not.toHaveBeenCalled();
	});

	it("returns an error result when the SDK query throws", async () => {
		queryMock.mockImplementation(() => {
			throw new Error("sdk boom");
		});

		const { runClaudeAgentViaSdk } = await import("./claude-sdk-runner.ts");
		const result = await runClaudeAgentViaSdk(
			"/tmp/project",
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
			"do work",
			undefined,
			undefined,
			undefined,
			(results) => ({ mode: "single", inheritMainContext: false, projectAgentsDir: null, results }),
			undefined,
			sidecarFile,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("claude-sdk error: sdk boom");
	});

	it("throws when the outer abort signal is triggered before execution completes", async () => {
		queryMock.mockReturnValue(makeQuery([]));
		const abortController = new AbortController();
		abortController.abort();

		const { runClaudeAgentViaSdk } = await import("./claude-sdk-runner.ts");
		await expect(
			runClaudeAgentViaSdk(
				"/tmp/project",
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
				"do work",
				undefined,
				abortController.signal,
				undefined,
				(results) => ({ mode: "single", inheritMainContext: false, projectAgentsDir: null, results }),
				undefined,
				sidecarFile,
			),
		).rejects.toThrow("Subagent was aborted");
		expect(queryMock).not.toHaveBeenCalled();
	});
});
