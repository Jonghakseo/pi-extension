import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgents } from "./agents.ts";

function createTempAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-runtime-test-"));
	return dir;
}

function writeAgentFile(dir: string, filename: string, content: string): void {
	fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("runtime frontmatter parsing", () => {
	it("defaults to 'pi' when runtime is not specified", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"worker.md",
			["---", "name: worker", "description: A worker agent", "---", "Do work."].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		const worker = result.agents.find((a) => a.name === "worker");
		expect(worker).toBeDefined();
		expect(worker?.runtime).toBe("pi");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads runtime: claude from frontmatter", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"claude-agent.md",
			[
				"---",
				"name: claude-agent",
				"description: A Claude runtime agent",
				"runtime: claude",
				"---",
				"Do work with Claude.",
			].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		const agent = result.agents.find((a) => a.name === "claude-agent");
		expect(agent).toBeDefined();
		expect(agent?.runtime).toBe("claude");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("reads runtime: pi from frontmatter", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"pi-agent.md",
			["---", "name: pi-agent", "description: A Pi runtime agent", "runtime: pi", "---", "Do work with Pi."].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		const agent = result.agents.find((a) => a.name === "pi-agent");
		expect(agent).toBeDefined();
		expect(agent?.runtime).toBe("pi");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("treats unknown runtime values as 'pi'", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"unknown-rt.md",
			["---", "name: unknown-rt", "description: Agent with unknown runtime", "runtime: openai", "---", "Do work."].join(
				"\n",
			),
		);

		const result = discoverAgents(tmpDir);
		const agent = result.agents.find((a) => a.name === "unknown-rt");
		expect(agent).toBeDefined();
		expect(agent?.runtime).toBe("pi");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("defaults project .claude agents to 'pi' when runtime is not specified", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"gemini-self-reviewer.md",
			[
				"---",
				"name: gemini-self-reviewer",
				"description: Claude-format project agent",
				"tools: Bash, Read, Glob, Grep",
				"model: haiku",
				"---",
				"Review the code.",
			].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		const agent = result.agents.find((a) => a.name === "gemini-self-reviewer");
		expect(agent).toBeDefined();
		expect(agent?.runtime).toBe("pi");
		expect(agent?.model).toBe("claude-haiku-4-5");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("respects explicit runtime: claude for project .claude agents", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"claude-in-claude-dir.md",
			[
				"---",
				"name: claude-in-claude-dir",
				"description: Claude-format project agent explicitly using Claude runtime",
				"runtime: claude",
				"model: haiku",
				"---",
				"Do work.",
			].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		const agent = result.agents.find((a) => a.name === "claude-in-claude-dir");
		expect(agent).toBeDefined();
		expect(agent?.runtime).toBe("claude");
		expect(agent?.model).toBe("claude-haiku-4-5");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("runtime-aware prompt injection", () => {
	it("pi runtime agents include ask_master guideline", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"pi-worker.md",
			["---", "name: pi-worker", "description: Pi worker", "---", "Do pi work."].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		const agent = result.agents.find((a) => a.name === "pi-worker");
		expect(agent).toBeDefined();
		expect(agent?.systemPrompt).toContain("ask_master Guideline:");
		expect(agent?.systemPrompt).toContain("ask_master");
		expect(agent?.systemPrompt).not.toContain("Blocker Reporting Guideline:");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("claude runtime agents do NOT include ask_master guideline", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"claude-worker.md",
			["---", "name: claude-worker", "description: Claude worker", "runtime: claude", "---", "Do claude work."].join(
				"\n",
			),
		);

		const result = discoverAgents(tmpDir);
		const agent = result.agents.find((a) => a.name === "claude-worker");
		expect(agent).toBeDefined();
		expect(agent?.systemPrompt).not.toContain("ask_master Guideline:");
		expect(agent?.systemPrompt).not.toContain("Use `ask_master` when:");
		expect(agent?.systemPrompt).toContain("Blocker Reporting Guideline:");
		expect(agent?.systemPrompt).toContain("Do NOT attempt to call tools that are not available");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("both runtimes include the no-recursion rule", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(agentsDir, "pi-a.md", ["---", "name: pi-a", "description: Pi A", "---", "Work."].join("\n"));
		writeAgentFile(
			agentsDir,
			"claude-a.md",
			["---", "name: claude-a", "description: Claude A", "runtime: claude", "---", "Work."].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		const piAgent = result.agents.find((a) => a.name === "pi-a");
		const claudeAgent = result.agents.find((a) => a.name === "claude-a");

		expect(piAgent?.systemPrompt).toContain("Global Runtime Rule (subagent):");
		expect(claudeAgent?.systemPrompt).toContain("Global Runtime Rule (subagent):");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});
