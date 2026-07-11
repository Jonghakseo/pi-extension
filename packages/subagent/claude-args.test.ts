import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, findProjectMcpConfig } from "./claude-args.ts";

describe("buildClaudeArgs", () => {
	it("produces base args with --verbose, stream-json, partial messages, dangerous skip permissions, and --strict-mcp-config", () => {
		const args = buildClaudeArgs({
			prompt: "say ok",
			tools: ["read", "bash"],
		});

		expect(args).toContain("-p");
		expect(args).toContain("--verbose");
		expect(args).toContain("--strict-mcp-config");
		expect(args).toContain("stream-json");
		expect(args).toContain("--include-partial-messages");
		expect(args).toContain("--dangerously-skip-permissions");
		expect(args.indexOf("--output-format")).toBeLessThan(args.indexOf("stream-json"));
	});

	it("never includes --bare", () => {
		const args = buildClaudeArgs({
			prompt: "say ok",
			tools: ["read", "bash", "edit", "write"],
		});

		expect(args).not.toContain("--bare");
	});

	it("maps pi tools to Claude tools for --tools and --allowedTools", () => {
		const args = buildClaudeArgs({
			prompt: "do work",
			tools: ["read", "bash", "edit", "write", "grep", "find"],
		});

		const toolsIdx = args.indexOf("--tools");
		const allowedIdx = args.indexOf("--allowedTools");
		expect(toolsIdx).toBeGreaterThanOrEqual(0);
		expect(allowedIdx).toBeGreaterThanOrEqual(0);

		const toolsValue = args[toolsIdx + 1];
		const allowedValue = args[allowedIdx + 1];

		expect(toolsValue).toBe(allowedValue);

		const toolList = toolsValue.split(",");
		expect(toolList).toContain("Read");
		expect(toolList).toContain("Bash");
		expect(toolList).toContain("Edit");
		expect(toolList).toContain("Write");
		expect(toolList).toContain("Grep");
		expect(toolList).toContain("Glob");
	});

	it("--tools and --allowedTools always match", () => {
		const args = buildClaudeArgs({
			prompt: "task",
			tools: ["bash", "edit"],
		});

		const toolsIdx = args.indexOf("--tools");
		const allowedIdx = args.indexOf("--allowedTools");
		expect(args[toolsIdx + 1]).toBe(args[allowedIdx + 1]);
	});

	it("--strict-mcp-config is always present", () => {
		const args = buildClaudeArgs({
			prompt: "task",
			tools: ["read"],
		});
		expect(args).toContain("--strict-mcp-config");
	});

	it("includes --mcp-config when mcpConfigPath is provided", () => {
		const args = buildClaudeArgs({
			prompt: "task",
			tools: ["read"],
			mcpConfigPath: "/path/to/mcp.json",
		});

		const idx = args.indexOf("--mcp-config");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("/path/to/mcp.json");
		expect(args).toContain("--strict-mcp-config");
	});

	it("works correctly when no MCP config is provided", () => {
		const args = buildClaudeArgs({
			prompt: "task",
			tools: ["read"],
		});

		expect(args).toContain("--strict-mcp-config");
		expect(args).not.toContain("--mcp-config");
	});

	it("includes --resume when resumeSessionId is provided", () => {
		const sessionId = "f110cdeb-3b75-4dd8-a8f8-f09d762ef971";
		const args = buildClaudeArgs({
			prompt: "continue",
			tools: ["read"],
			resumeSessionId: sessionId,
		});

		const idx = args.indexOf("--resume");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe(sessionId);
	});

	it("does not include --resume when resumeSessionId is absent", () => {
		const args = buildClaudeArgs({
			prompt: "task",
			tools: ["read"],
		});
		expect(args).not.toContain("--resume");
	});

	it("strips anthropic/ prefix from model", () => {
		const args = buildClaudeArgs({
			prompt: "task",
			tools: ["read"],
			model: "anthropic/claude-opus-4-7",
		});

		const idx = args.indexOf("--model");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("claude-opus-4-7");
	});

	it("passes model as-is when no anthropic/ prefix", () => {
		const args = buildClaudeArgs({
			prompt: "task",
			tools: ["read"],
			model: "claude-sonnet-4-6",
		});

		const idx = args.indexOf("--model");
		expect(args[idx + 1]).toBe("claude-sonnet-4-6");
	});

	it("maps pi thinking values to Claude CLI --effort levels", () => {
		const cases: [string, string][] = [
			["off", "low"],
			["minimal", "low"],
			["low", "medium"],
			["medium", "high"],
			["high", "max"],
			["xhigh", "max"],
			["max", "max"],
		];
		for (const [input, expected] of cases) {
			const args = buildClaudeArgs({ prompt: "task", tools: ["read"], thinking: input });
			const idx = args.indexOf("--effort");
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(args[idx + 1]).toBe(expected);
		}
	});

	it("does not emit --effort for unrecognized thinking values", () => {
		const args = buildClaudeArgs({ prompt: "task", tools: ["read"], thinking: "unknown_value" });
		expect(args).not.toContain("--effort");
		expect(args).not.toContain("--thinking");
	});

	it("includes --append-system-prompt-file when systemPromptFile is provided", () => {
		const args = buildClaudeArgs({
			prompt: "task",
			tools: ["read"],
			systemPromptFile: "/tmp/prompt.txt",
		});

		const idx = args.indexOf("--append-system-prompt-file");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("/tmp/prompt.txt");
	});

	it("places prompt as the last argument", () => {
		const args = buildClaudeArgs({
			prompt: "do the thing",
			tools: ["read", "bash"],
			model: "claude-opus-4-7",
			thinking: "enabled",
		});

		expect(args[args.length - 1]).toBe("do the thing");
	});

	it("throws on unsupported tools", () => {
		expect(() =>
			buildClaudeArgs({
				prompt: "task",
				tools: ["todo"],
			}),
		).toThrow(/Unsupported tool/);
	});

	it("auto-discovers .mcp.json from cwd", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-args-test-"));
		const mcpPath = path.join(tmpDir, ".mcp.json");
		fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));

		try {
			const args = buildClaudeArgs({
				prompt: "task",
				tools: ["read"],
				cwd: tmpDir,
			});

			const idx = args.indexOf("--mcp-config");
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(args[idx + 1]).toBe(mcpPath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("explicit mcpConfigPath takes precedence over cwd discovery", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-args-test-"));
		fs.writeFileSync(path.join(tmpDir, ".mcp.json"), "{}");

		try {
			const args = buildClaudeArgs({
				prompt: "task",
				tools: ["read"],
				cwd: tmpDir,
				mcpConfigPath: "/explicit/mcp.json",
			});

			const idx = args.indexOf("--mcp-config");
			expect(args[idx + 1]).toBe("/explicit/mcp.json");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("findProjectMcpConfig", () => {
	it("returns path when .mcp.json exists", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-find-test-"));
		const mcpPath = path.join(tmpDir, ".mcp.json");
		fs.writeFileSync(mcpPath, "{}");

		try {
			expect(findProjectMcpConfig(tmpDir)).toBe(mcpPath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("walks parent directories to find project .mcp.json", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-find-test-"));
		const nestedDir = path.join(tmpDir, "packages", "nested", "src");
		const mcpPath = path.join(tmpDir, ".mcp.json");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(mcpPath, "{}");

		try {
			expect(findProjectMcpConfig(nestedDir)).toBe(mcpPath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns undefined when no MCP config exists", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-find-test-"));

		try {
			expect(findProjectMcpConfig(tmpDir)).toBeUndefined();
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("buildClaudeArgs flag correctness", () => {
	it("never emits --thinking (removed flag)", () => {
		const cases = ["off", "low", "medium", "high", "xhigh", "max", "enabled", "adaptive", "disabled"];
		for (const thinking of cases) {
			const args = buildClaudeArgs({ prompt: "task", tools: ["read"], thinking });
			expect(args).not.toContain("--thinking");
		}
	});

	it("uses --append-system-prompt-file not --append-system-prompt for file paths", () => {
		const args = buildClaudeArgs({
			prompt: "task",
			tools: ["read"],
			systemPromptFile: "/tmp/system.md",
		});
		expect(args).not.toContain("--append-system-prompt");
		expect(args).toContain("--append-system-prompt-file");
	});

	it("uses --effort not --thinking for thinking values", () => {
		const args = buildClaudeArgs({ prompt: "task", tools: ["read"], thinking: "high" });
		expect(args).toContain("--effort");
		expect(args).not.toContain("--thinking");
	});

	it("omits --tools and --allowedTools when tool list is empty", () => {
		const args = buildClaudeArgs({ prompt: "task", tools: [] });
		expect(args).not.toContain("--tools");
		expect(args).not.toContain("--allowedTools");
	});

	it("always includes --include-partial-messages for incremental stream events", () => {
		const args = buildClaudeArgs({ prompt: "task", tools: ["read"] });
		expect(args).toContain("--include-partial-messages");
	});
});
