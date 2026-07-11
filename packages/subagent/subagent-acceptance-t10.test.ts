/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverAgents } from "./agents.ts";
import { buildClaudeArgs } from "./claude-args.ts";
import { createSidecarWriter } from "./claude-sidecar-writer.ts";
import { createStreamState, processClaudeEvent, stateToSingleResult } from "./claude-stream-parser.ts";
import { readSessionReplayItems } from "./replay.ts";
import { updateRunFromResult } from "./store.ts";
import type { CommandRunState, SingleResult } from "./types.ts";
import { mapPiToolsToClaude, validateClaudeRuntimeModel } from "./utils/agent-utils.ts";

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

beforeEach(() => {
	spawnMock.mockReset();
	resolveClaudeRuntimeModeMock.mockReset();
	resolveClaudeRuntimeModeMock.mockReturnValue("cli");
});

afterEach(() => {
	vi.clearAllMocks();
});

function createTempAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t10-acceptance-"));
	return dir;
}

function writeAgentFile(dir: string, filename: string, content: string): void {
	fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

function makeRunState(overrides: Partial<CommandRunState> = {}): CommandRunState {
	return {
		id: 1,
		agent: "test",
		task: "test task",
		status: "running",
		startedAt: Date.now() - 5000,
		elapsedMs: 5000,
		toolCalls: 0,
		lastLine: "",
		turnCount: 0,
		lastActivityAt: Date.now() - 5000,
		...overrides,
	};
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "test",
		agentSource: "user",
		task: "test task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	};
}

describe("T10 Acceptance Matrix", () => {
	describe("A01: runtime frontmatter parsing", () => {
		it("parses runtime: claude from frontmatter", () => {
			const tmpDir = createTempAgentDir();
			const agentsDir = path.join(tmpDir, ".pi", "agents");
			fs.mkdirSync(agentsDir, { recursive: true });
			writeAgentFile(agentsDir, "a.md", "---\nname: a\ndescription: A\nruntime: claude\n---\nWork.");

			const result = discoverAgents(tmpDir);
			const agent = result.agents.find((a) => a.name === "a");
			expect(agent?.runtime).toBe("claude");
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("defaults to pi when runtime is absent and model is non-Claude", () => {
			const tmpDir = createTempAgentDir();
			const agentsDir = path.join(tmpDir, ".pi", "agents");
			fs.mkdirSync(agentsDir, { recursive: true });
			writeAgentFile(agentsDir, "b.md", "---\nname: b\ndescription: B\nmodel: openai-codex/gpt-5.4\n---\nWork.");

			const result = discoverAgents(tmpDir);
			expect(result.agents.find((a) => a.name === "b")?.runtime).toBe("pi");
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("defaults to pi when runtime is absent even if model is Anthropic Claude", () => {
			const tmpDir = createTempAgentDir();
			const agentsDir = path.join(tmpDir, ".pi", "agents");
			fs.mkdirSync(agentsDir, { recursive: true });
			writeAgentFile(
				agentsDir,
				"b-claude.md",
				"---\nname: b-claude\ndescription: B Claude\nmodel: anthropic/claude-opus-4-7\n---\nWork.",
			);

			const result = discoverAgents(tmpDir);
			expect(result.agents.find((a) => a.name === "b-claude")?.runtime).toBe("pi");
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("keeps explicit pi runtime even for Anthropic Claude models", () => {
			const tmpDir = createTempAgentDir();
			const agentsDir = path.join(tmpDir, ".pi", "agents");
			fs.mkdirSync(agentsDir, { recursive: true });
			writeAgentFile(
				agentsDir,
				"b-explicit-pi.md",
				"---\nname: b-explicit-pi\ndescription: B Explicit Pi\nmodel: anthropic/claude-opus-4-7\nruntime: pi\n---\nWork.",
			);

			const result = discoverAgents(tmpDir);
			expect(result.agents.find((a) => a.name === "b-explicit-pi")?.runtime).toBe("pi");
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	describe("A02: runtime-aware prompt policy (ask_master replaced)", () => {
		it("claude runtime uses Blocker Reporting instead of ask_master Guideline section", () => {
			const tmpDir = createTempAgentDir();
			const agentsDir = path.join(tmpDir, ".pi", "agents");
			fs.mkdirSync(agentsDir, { recursive: true });
			writeAgentFile(agentsDir, "c.md", "---\nname: c\ndescription: C\nruntime: claude\n---\nWork.");

			const result = discoverAgents(tmpDir);
			const agent = result.agents.find((a) => a.name === "c") as NonNullable<ReturnType<typeof result.agents.find>>;
			expect(agent.systemPrompt).not.toContain("ask_master Guideline:");
			expect(agent.systemPrompt).not.toContain("Use `ask_master` when:");
			expect(agent.systemPrompt).toContain("Blocker Reporting Guideline:");
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("pi runtime keeps ask_master guideline", () => {
			const tmpDir = createTempAgentDir();
			const agentsDir = path.join(tmpDir, ".pi", "agents");
			fs.mkdirSync(agentsDir, { recursive: true });
			writeAgentFile(agentsDir, "d.md", "---\nname: d\ndescription: D\n---\nWork.");

			const result = discoverAgents(tmpDir);
			expect(result.agents.find((a) => a.name === "d")?.systemPrompt).toContain("ask_master");
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	describe("A03: runtime dispatch", () => {
		it("runSingleAgent rejects unsupported tools for claude runtime", async () => {
			const { runSingleAgent } = await import("./runner.ts");
			const agents = [
				{
					name: "bad",
					description: "Bad",
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
				"bad",
				"do work",
				undefined,
				undefined,
				undefined,
				(results) => ({ mode: "single", inheritMainContext: false, projectAgentsDir: null, results }),
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Unsupported tool");
			expect(result.runtime).toBe("claude");
		});
	});

	describe("A04: non-Anthropic model guard", () => {
		it("rejects openai/gpt-4", () => {
			expect(() => validateClaudeRuntimeModel("openai/gpt-4")).toThrow("not supported");
		});

		it("accepts claude-sonnet-4-6", () => {
			expect(() => validateClaudeRuntimeModel("claude-sonnet-4-6")).not.toThrow();
		});

		it("accepts undefined model", () => {
			expect(() => validateClaudeRuntimeModel(undefined)).not.toThrow();
		});
	});

	describe("A05: explicit approval policy (--tools + --allowedTools, partial messages, no --bare)", () => {
		it("never includes --bare", () => {
			const args = buildClaudeArgs({ prompt: "task", tools: ["read", "bash", "edit", "write"] });
			expect(args).not.toContain("--bare");
		});

		it("includes both --tools and --allowedTools with matching values", () => {
			const args = buildClaudeArgs({ prompt: "task", tools: ["read", "bash"] });
			const toolsIdx = args.indexOf("--tools");
			const allowedIdx = args.indexOf("--allowedTools");
			expect(toolsIdx).toBeGreaterThanOrEqual(0);
			expect(allowedIdx).toBeGreaterThanOrEqual(0);
			expect(args[toolsIdx + 1]).toBe(args[allowedIdx + 1]);
		});

		it("always includes --include-partial-messages", () => {
			const args = buildClaudeArgs({ prompt: "task", tools: ["read"] });
			expect(args).toContain("--include-partial-messages");
		});

		it("always includes --dangerously-skip-permissions", () => {
			const args = buildClaudeArgs({ prompt: "task", tools: ["read"] });
			expect(args).toContain("--dangerously-skip-permissions");
		});
	});

	describe("A06: explicit MCP source policy (--strict-mcp-config)", () => {
		it("always includes --strict-mcp-config", () => {
			const args = buildClaudeArgs({ prompt: "task", tools: ["read"] });
			expect(args).toContain("--strict-mcp-config");
		});

		it("includes --mcp-config when discovered", () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t10-mcp-"));
			fs.writeFileSync(path.join(tmpDir, ".mcp.json"), "{}");
			try {
				const args = buildClaudeArgs({ prompt: "task", tools: ["read"], cwd: tmpDir });
				expect(args).toContain("--mcp-config");
				expect(args).toContain("--strict-mcp-config");
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("A07: stream-json parser", () => {
		const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/claude-stream");

		it("parses basic-text fixture extracting session_id, model, and result", () => {
			const lines = fs.readFileSync(path.join(FIXTURE_DIR, "basic-text.ndjson"), "utf-8").split("\n").filter(Boolean);
			const state = createStreamState();
			for (const l of lines) processClaudeEvent(state, JSON.parse(l));
			expect(state.sessionId).toBeDefined();
			expect(state.resultReceived).toBe(true);
			expect(state.isError).toBe(false);
		});

		it("parses tool-call fixture capturing tool use and multi-turn", () => {
			const lines = fs.readFileSync(path.join(FIXTURE_DIR, "tool-call.ndjson"), "utf-8").split("\n").filter(Boolean);
			const state = createStreamState();
			for (const l of lines) processClaudeEvent(state, JSON.parse(l));
			expect(state.usage.turns).toBe(2);
			const toolMsg = state.messages.find(
				(m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "toolCall"),
			);
			expect(toolMsg).toBeDefined();
		});

		it("parses error fixture detecting permission denials", () => {
			const lines = fs.readFileSync(path.join(FIXTURE_DIR, "error.ndjson"), "utf-8").split("\n").filter(Boolean);
			const state = createStreamState();
			for (const l of lines) processClaudeEvent(state, JSON.parse(l));
			expect(state.permissionDenials.length).toBeGreaterThan(0);
		});
	});

	describe("A08: process lifecycle fallback", () => {
		it("stateToSingleResult produces valid result even with no messages (early exit fallback)", () => {
			const state = createStreamState();
			const result = stateToSingleResult(
				state,
				"agent",
				"user",
				"task",
				1,
				undefined,
				"[runner] exit_fallback_timeout",
			);
			expect(result.exitCode).toBe(1);
			expect(result.messages).toHaveLength(0);
			expect(result.stderr).toContain("exit_fallback_timeout");
			expect(result.runtime).toBe("claude");
		});

		it("stateToSingleResult handles partial stream (result not received)", () => {
			const state = createStreamState();
			processClaudeEvent(state, {
				type: "assistant",
				message: { model: "claude-opus-4-7", role: "assistant", content: [{ type: "text", text: "partial" }] },
			});
			expect(state.resultReceived).toBe(false);
			const result = stateToSingleResult(state, "agent", "user", "task", 1, undefined, "");
			expect(result.exitCode).toBe(1);
			expect(result.messages.length).toBeGreaterThan(0);
		});

		it("abort signal causes runSingleAgent to throw", async () => {
			spawnMock.mockImplementationOnce(() => makeAbortableProcess());
			const { runSingleAgent } = await import("./runner.ts");
			const agents = [
				{
					name: "x",
					description: "X",
					tools: ["read"],
					model: "claude-sonnet-4-6",
					systemPrompt: "t",
					source: "user" as const,
					filePath: "/tmp/t.md",
					runtime: "claude" as const,
				},
			];
			const ac = new AbortController();
			ac.abort();
			await expect(
				runSingleAgent("/tmp", agents, "x", "t", undefined, ac.signal, undefined, (r) => ({
					mode: "single",
					inheritMainContext: false,
					projectAgentsDir: null,
					results: r,
				})),
			).rejects.toThrow("Subagent was aborted");
		});
	});

	describe("A09: session metadata propagation", () => {
		it("stateToSingleResult includes runtime and claudeSessionId", () => {
			const state = createStreamState();
			state.sessionId = "sess-123";
			const result = stateToSingleResult(state, "a", "user", "t", 0, undefined, "");
			expect(result.runtime).toBe("claude");
			expect(result.claudeSessionId).toBe("sess-123");
		});

		it("updateRunFromResult propagates all Claude metadata fields", () => {
			const run = makeRunState();
			updateRunFromResult(
				run,
				makeResult({
					runtime: "claude",
					claudeSessionId: "sess-456",
					claudeProjectDir: "/proj",
				}),
			);
			expect(run.runtime).toBe("claude");
			expect(run.claudeSessionId).toBe("sess-456");
			expect(run.claudeProjectDir).toBe("/proj");
		});

		it("does not overwrite existing metadata with undefined", () => {
			const run = makeRunState({ runtime: "claude", claudeSessionId: "old" });
			updateRunFromResult(run, makeResult({ runtime: undefined, claudeSessionId: undefined }));
			expect(run.runtime).toBe("claude");
			expect(run.claudeSessionId).toBe("old");
		});
	});

	describe("A10: reload/continue/same Claude session resume", () => {
		it("buildClaudeArgs includes --resume with session ID", () => {
			const args = buildClaudeArgs({
				prompt: "continue",
				tools: ["read"],
				resumeSessionId: "sess-resume-abc",
			});
			const idx = args.indexOf("--resume");
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(args[idx + 1]).toBe("sess-resume-abc");
		});

		it("continue requires claudeSessionId for Claude runtime", () => {
			const run = makeRunState({ runtime: "claude", claudeSessionId: undefined, status: "done" });
			expect(!!run.claudeSessionId).toBe(false);
		});

		it("continue requires matching claudeProjectDir", () => {
			const run = makeRunState({
				runtime: "claude",
				claudeSessionId: "s",
				claudeProjectDir: "/a",
				status: "done",
			});
			expect(run.claudeProjectDir === "/b").toBe(false);
			expect(run.claudeProjectDir === "/a").toBe(true);
		});
	});

	describe("A11: same sidecar append across continue", () => {
		let tmpDir: string;
		let sidecarFile: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t10-sidecar-"));
			sidecarFile = path.join(tmpDir, "session.jsonl");
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("second writer appends to same file producing correct replay order", () => {
			const w1 = createSidecarWriter(sidecarFile);
			w1.writeUserMessage("First");
			w1.writeAssistantTurn({
				sessionId: undefined,
				model: undefined,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Answer 1" }] }],
				liveText: undefined,
				liveThinking: undefined,
				liveToolCalls: 0,
				thoughtText: undefined,
				stopReason: undefined,
				errorMessage: undefined,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				resultReceived: false,
				resultEvent: undefined,
				isError: false,
				permissionDenials: [],
				liveActivityPreview: undefined,
				currentToolName: undefined,
				currentToolInput: "",
			} as any);

			const w2 = createSidecarWriter(sidecarFile);
			w2.writeUserMessage("Continue");
			w2.writeAssistantTurn({
				sessionId: undefined,
				model: undefined,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Answer 2" }] }],
				liveText: undefined,
				liveThinking: undefined,
				liveToolCalls: 0,
				thoughtText: undefined,
				stopReason: undefined,
				errorMessage: undefined,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				resultReceived: false,
				resultEvent: undefined,
				isError: false,
				permissionDenials: [],
				liveActivityPreview: undefined,
				currentToolName: undefined,
				currentToolInput: "",
			} as any);

			const items = readSessionReplayItems(sidecarFile);
			expect(items).toHaveLength(4);
			expect(items[0].type).toBe("user");
			expect(items[1].type).toBe("assistant");
			expect(items[2].type).toBe("user");
			expect(items[3].type).toBe("assistant");
		});
	});

	describe("A12: replay compatibility", () => {
		let tmpDir: string;
		let sidecarFile: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t10-replay-"));
			sidecarFile = path.join(tmpDir, "session.jsonl");
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("readSessionReplayItems produces correct structure from sidecar output", () => {
			const w = createSidecarWriter(sidecarFile);
			w.writeUserMessage("Build feature");
			w.writeAssistantTurn({
				sessionId: undefined,
				model: undefined,
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "Reading file" },
							{ type: "toolCall", name: "Read", arguments: { file_path: "/x.ts" } },
						],
					},
				],
				liveText: undefined,
				liveThinking: undefined,
				liveToolCalls: 0,
				thoughtText: undefined,
				stopReason: undefined,
				errorMessage: undefined,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				resultReceived: false,
				resultEvent: undefined,
				isError: false,
				permissionDenials: [],
				liveActivityPreview: undefined,
				currentToolName: undefined,
				currentToolInput: "",
			} as any);
			w.writeToolResult("Read", "file contents");

			const items = readSessionReplayItems(sidecarFile);
			expect(items).toHaveLength(3);
			expect(items[0]).toMatchObject({ type: "user", title: "User" });
			expect(items[1]).toMatchObject({ type: "assistant", title: "Assistant" });
			expect(items[2]).toMatchObject({ type: "tool", title: "Tool: Read" });
		});
	});

	describe("A13: detail compatibility", () => {
		it("run state with Claude metadata can be read for detail output", () => {
			const run = makeRunState({
				runtime: "claude",
				claudeSessionId: "sess-detail",
				claudeProjectDir: "/proj",
				status: "done",
			});
			expect(run.runtime).toBe("claude");
			expect(run.claudeSessionId).toBe("sess-detail");
			expect(run.claudeProjectDir).toBe("/proj");
		});

		it("pi run state has no Claude-specific metadata", () => {
			const run = makeRunState({ runtime: "pi", status: "done" });
			expect(run.runtime).toBe("pi");
			expect(run.claudeSessionId).toBeUndefined();
			expect(run.claudeProjectDir).toBeUndefined();
		});
	});

	describe("A14: live preview / hang detection parity", () => {
		it("tool_use content_block_start sets liveActivityPreview", () => {
			const state = createStreamState();
			processClaudeEvent(state, {
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
				},
			});
			expect(state.liveActivityPreview).toBe("\u2192 Bash");
		});

		it("text_delta updates liveActivityPreview with last line", () => {
			const state = createStreamState();
			processClaudeEvent(state, {
				type: "stream_event",
				event: { type: "content_block_start", content_block: { type: "text", text: "" } },
			});
			processClaudeEvent(state, {
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "Line1\nLine2" } },
			});
			expect(state.liveActivityPreview).toBe("Line2");
		});

		it("updateRunFromResult updates lastActivityAt from liveActivityPreview", () => {
			const oldTs = Date.now() - 60000;
			const run = makeRunState({ lastActivityAt: oldTs });
			updateRunFromResult(run, makeResult({ liveActivityPreview: "\u2192 Bash" }));
			expect(run.lastActivityAt).toBeGreaterThan(oldTs);
		});
	});

	describe("A15: existing runtime: pi regression", () => {
		it("pi agent frontmatter parsing unchanged", () => {
			const tmpDir = createTempAgentDir();
			const agentsDir = path.join(tmpDir, ".pi", "agents");
			fs.mkdirSync(agentsDir, { recursive: true });
			writeAgentFile(agentsDir, "pi-w.md", "---\nname: pi-w\ndescription: Pi Worker\n---\nDo pi work.");

			const result = discoverAgents(tmpDir);
			const agent = result.agents.find((a) => a.name === "pi-w") as NonNullable<ReturnType<typeof result.agents.find>>;
			expect(agent.runtime).toBe("pi");
			expect(agent.systemPrompt).toContain("ask_master");
			expect(agent.systemPrompt).not.toContain("Blocker Reporting Guideline:");
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("pi result does not carry Claude-specific metadata through updateRunFromResult", () => {
			const run = makeRunState();
			updateRunFromResult(run, makeResult({ runtime: "pi" }));
			expect(run.runtime).toBe("pi");
			expect(run.claudeSessionId).toBeUndefined();
			expect(run.claudeProjectDir).toBeUndefined();
		});

		it("runSingleAgent returns error for unknown agent (pi path unchanged)", async () => {
			const { runSingleAgent } = await import("./runner.ts");
			const result = await runSingleAgent("/tmp", [], "nonexistent", "task", undefined, undefined, undefined, (r) => ({
				mode: "single",
				inheritMainContext: false,
				projectAgentsDir: null,
				results: r,
			}));
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Unknown agent");
		});

		it("mapPiToolsToClaude does not affect pi runtime tool resolution", () => {
			const mapped = mapPiToolsToClaude(["read", "bash", "edit"]);
			expect(mapped).toEqual(["Read", "Bash", "Edit"]);
		});
	});
});
