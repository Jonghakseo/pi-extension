import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapPiToolsToClaude, PI_TO_CLAUDE_TOOL_MAP, validateClaudeRuntimeModel } from "./utils/agent-utils.ts";

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

function makeAbortableProcess(): MockProc {
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
	return proc;
}

describe("PI_TO_CLAUDE_TOOL_MAP", () => {
	it("maps all expected pi tools to Claude equivalents", () => {
		expect(PI_TO_CLAUDE_TOOL_MAP.read).toBe("Read");
		expect(PI_TO_CLAUDE_TOOL_MAP.find).toBe("Glob");
		expect(PI_TO_CLAUDE_TOOL_MAP.grep).toBe("Grep");
		expect(PI_TO_CLAUDE_TOOL_MAP.bash).toBe("Bash");
		expect(PI_TO_CLAUDE_TOOL_MAP.edit).toBe("Edit");
		expect(PI_TO_CLAUDE_TOOL_MAP.write).toBe("Write");
		expect(PI_TO_CLAUDE_TOOL_MAP.ls).toBe("LS");
	});

	it("has exactly 7 entries", () => {
		expect(Object.keys(PI_TO_CLAUDE_TOOL_MAP)).toHaveLength(7);
	});
});

describe("mapPiToolsToClaude", () => {
	it("maps valid pi tools to Claude tools", () => {
		expect(mapPiToolsToClaude(["read", "write", "bash"])).toEqual(["Read", "Write", "Bash"]);
	});

	it("deduplicates mapped tools", () => {
		expect(mapPiToolsToClaude(["read", "read"])).toEqual(["Read"]);
	});

	it("throws for unsupported tools", () => {
		expect(() => mapPiToolsToClaude(["read", "todo"])).toThrow('Unsupported tool "todo" for Claude runtime');
	});

	it("throws with list of supported tools in error message", () => {
		expect(() => mapPiToolsToClaude(["unknown"])).toThrow("Supported tools:");
	});

	it("maps all supported tools correctly", () => {
		const result = mapPiToolsToClaude(["read", "find", "grep", "bash", "edit", "write", "ls"]);
		expect(result).toEqual(["Read", "Glob", "Grep", "Bash", "Edit", "Write", "LS"]);
	});

	it("maps ls tool for Claude runtime", () => {
		expect(mapPiToolsToClaude(["ls"])).toEqual(["LS"]);
	});
});

describe("validateClaudeRuntimeModel", () => {
	it("accepts undefined model", () => {
		expect(() => validateClaudeRuntimeModel(undefined)).not.toThrow();
	});

	it("accepts anthropic/claude-* models", () => {
		expect(() => validateClaudeRuntimeModel("anthropic/claude-sonnet-4-6")).not.toThrow();
		expect(() => validateClaudeRuntimeModel("anthropic/claude-opus-4-7")).not.toThrow();
		expect(() => validateClaudeRuntimeModel("anthropic/claude-haiku-4-5")).not.toThrow();
	});

	it("accepts claude-* models without provider prefix", () => {
		expect(() => validateClaudeRuntimeModel("claude-sonnet-4-6")).not.toThrow();
		expect(() => validateClaudeRuntimeModel("claude-opus-4-7")).not.toThrow();
	});

	it("is case-insensitive", () => {
		expect(() => validateClaudeRuntimeModel("Anthropic/Claude-Sonnet-4-6")).not.toThrow();
		expect(() => validateClaudeRuntimeModel("CLAUDE-OPUS-4-7")).not.toThrow();
	});

	it("rejects non-Anthropic models", () => {
		expect(() => validateClaudeRuntimeModel("openai/gpt-4")).toThrow(
			'Model "openai/gpt-4" is not supported with Claude runtime',
		);
	});

	it("rejects generic model names", () => {
		expect(() => validateClaudeRuntimeModel("gpt-4o")).toThrow("Only Anthropic models");
	});

	it("rejects models that contain claude but don't start with it", () => {
		expect(() => validateClaudeRuntimeModel("my-claude-fork")).toThrow("not supported with Claude runtime");
	});
});

describe("runSingleAgent runtime dispatch", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		resolveClaudeRuntimeModeMock.mockReset();
		resolveClaudeRuntimeModeMock.mockReturnValue("cli");
		vi.resetModules();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("runClaudeAgent respects abort signal and throws", async () => {
		spawnMock.mockImplementationOnce(() => makeAbortableProcess());
		const { runSingleAgent } = await import("./runner.ts");
		const agents = [
			{
				name: "test-claude",
				description: "Test Claude agent",
				tools: ["read", "bash"],
				model: "claude-sonnet-4-6",
				systemPrompt: "test",
				source: "user" as const,
				filePath: "/tmp/test.md",
				runtime: "claude" as const,
			},
		];

		const abortController = new AbortController();
		abortController.abort();

		await expect(
			runSingleAgent(
				"/tmp",
				agents,
				"test-claude",
				"do something",
				undefined,
				abortController.signal,
				undefined,
				(results) => ({
					mode: "single",
					inheritMainContext: false,
					projectAgentsDir: null,
					results,
				}),
			),
		).rejects.toThrow("Subagent was aborted");
	}, 10000);

	it("rejects non-Anthropic model in Claude runtime agent", async () => {
		const { runSingleAgent } = await import("./runner.ts");
		const agents = [
			{
				name: "bad-model",
				description: "Bad model agent",
				model: "openai/gpt-4",
				systemPrompt: "test",
				source: "user" as const,
				filePath: "/tmp/test.md",
				runtime: "claude" as const,
			},
		];

		const result = await runSingleAgent(
			"/tmp",
			agents,
			"bad-model",
			"do something",
			undefined,
			undefined,
			undefined,
			(results) => ({
				mode: "single",
				inheritMainContext: false,
				projectAgentsDir: null,
				results,
			}),
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not supported with Claude runtime");
		expect(result.runtime).toBe("claude");
	});

	it("rejects unsupported tools in Claude runtime agent", async () => {
		const { runSingleAgent } = await import("./runner.ts");
		const agents = [
			{
				name: "bad-tools",
				description: "Bad tools agent",
				tools: ["read", "todo"],
				model: "claude-sonnet-4-6",
				systemPrompt: "test",
				source: "user" as const,
				filePath: "/tmp/test.md",
				runtime: "claude" as const,
			},
		];

		const result = await runSingleAgent(
			"/tmp",
			agents,
			"bad-tools",
			"do something",
			undefined,
			undefined,
			undefined,
			(results) => ({
				mode: "single",
				inheritMainContext: false,
				projectAgentsDir: null,
				results,
			}),
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain('Unsupported tool "todo"');
		expect(result.runtime).toBe("claude");
	});

	it("returns unknown agent error for non-existent agent", async () => {
		const { runSingleAgent } = await import("./runner.ts");

		const result = await runSingleAgent(
			"/tmp",
			[],
			"nonexistent",
			"do something",
			undefined,
			undefined,
			undefined,
			(results) => ({
				mode: "single",
				inheritMainContext: false,
				projectAgentsDir: null,
				results,
			}),
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Unknown agent");
	});
});
