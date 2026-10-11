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
	it("discovers user agents from PI_CODING_AGENT_DIR", () => {
		const tmpDir = createTempAgentDir();
		const customAgentDir = path.join(tmpDir, "custom-agent-dir");
		const userAgentsDir = path.join(customAgentDir, "agents");
		fs.mkdirSync(userAgentsDir, { recursive: true });
		writeAgentFile(
			userAgentsDir,
			"custom-worker.md",
			["---", "name: custom-worker", "description: Custom user agent", "---", "Do work."].join("\n"),
		);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = customAgentDir;

		try {
			const result = discoverAgents(path.join(tmpDir, "project"));
			expect(result.agents.some((agent) => agent.name === "custom-worker")).toBe(true);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("skips malformed agent files while discovering valid siblings", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(agentsDir, "01-malformed.md", ["---", "name: [", "---", "Invalid."].join("\n"));
		writeAgentFile(
			agentsDir,
			"02-valid.md",
			["---", "name: valid-sibling", "description: A valid sibling agent", "---", "Do work."].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		expect(result.agents.some((agent) => agent.name === "valid-sibling")).toBe(true);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("skips non-string required metadata and accepts YAML array tools", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(
			agentsDir,
			"01-invalid-metadata.md",
			["---", "name: [invalid]", "description: Invalid metadata", "---", "Do not load."].join("\n"),
		);
		writeAgentFile(
			agentsDir,
			"02-array-tools.md",
			[
				"---",
				"name: array-tools",
				"description: Supports YAML array tools",
				"tools: [read, bash]",
				"---",
				"Do work.",
			].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		expect(result.agents.find((agent) => agent.name === "invalid")).toBeUndefined();
		expect(result.agents.find((agent) => agent.name === "array-tools")?.tools).toEqual(["read", "bash"]);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("ignores runtime: pi and unknown runtime values", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"pi-agent.md",
			["---", "name: pi-agent", "description: A Pi agent", "runtime: pi", "---", "Do work."].join("\n"),
		);
		writeAgentFile(
			agentsDir,
			"unknown-rt.md",
			["---", "name: unknown-rt", "description: Unknown runtime", "runtime: openai", "---", "Do work."].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		for (const name of ["pi-agent", "unknown-rt"]) {
			const agent = result.agents.find((a) => a.name === name);
			expect(agent).toBeDefined();
			expect(agent?.configurationError).toBeUndefined();
		}

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects runtime: claude with a configuration error", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"claude-agent.md",
			["---", "name: claude-agent", "description: Legacy Claude agent", "runtime: Claude", "---", "Do work."].join(
				"\n",
			),
		);
		const claudeAgentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(claudeAgentsDir, { recursive: true });
		writeAgentFile(
			claudeAgentsDir,
			"claude-bad-tools.md",
			[
				"---",
				"name: claude-bad-tools",
				"description: Legacy agent with bad tools",
				"runtime: claude",
				"tools: WebSearch",
				"---",
				"Do work.",
			].join("\n"),
		);

		const agents = discoverAgents(tmpDir).agents;
		for (const name of ["claude-agent", "claude-bad-tools"]) {
			const agent = agents.find((a) => a.name === name);
			expect(agent).toBeDefined();
			expect(agent?.configurationError).toContain('runtime "claude" is no longer supported');
		}

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("accepts max thinking from frontmatter", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"max-thinker.md",
			[
				"---",
				"name: max-thinker",
				"description: An agent that uses maximum reasoning",
				"thinking: max",
				"---",
				"Think deeply.",
			].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		const agent = result.agents.find((a) => a.name === "max-thinker");
		expect(agent?.thinking).toBe("max");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("loads project .claude agents with Claude model aliases", () => {
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
		expect(agent?.configurationError).toBeUndefined();
		expect(agent?.model).toBe("claude-haiku-4-5");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("preserves explicit empty Claude tools as a no-tools policy", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(
			agentsDir,
			"no-tools.md",
			["---", "name: no-tools", "description: No tools", "tools: []", "---", "Think only."].join("\n"),
		);

		const agent = discoverAgents(tmpDir).agents.find((candidate) => candidate.name === "no-tools");
		expect(agent?.toolsConfigured).toBe(true);
		expect(agent?.tools).toEqual([]);
		expect(agent?.configurationError).toBeUndefined();

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("keeps unsupported Claude tool definitions visible but invalid", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		writeAgentFile(
			agentsDir,
			"unsafe.md",
			["---", "name: unsafe", "description: Invalid tools", "tools: Read, WebSearch", "---", "Work."].join("\n"),
		);

		const agent = discoverAgents(tmpDir).agents.find((candidate) => candidate.name === "unsafe");
		expect(agent).toBeDefined();
		expect(agent?.configurationError).toContain("WebSearch");
		expect(agent?.tools).toBeUndefined();

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("lets an invalid higher-priority definition mask a valid user agent", () => {
		const tmpDir = createTempAgentDir();
		const customAgentDir = path.join(tmpDir, "user-config");
		const userAgentsDir = path.join(customAgentDir, "agents");
		const projectAgentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		writeAgentFile(
			userAgentsDir,
			"shared.md",
			["---", "name: shared", "description: Valid user agent", "tools: read", "---", "User."].join("\n"),
		);
		writeAgentFile(
			projectAgentsDir,
			"shared.md",
			["---", "name: shared", "description: Invalid project agent", "tools: WebSearch", "---", "Project."].join("\n"),
		);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = customAgentDir;

		try {
			const matches = discoverAgents(tmpDir).agents.filter((agent) => agent.name === "shared");
			expect(matches).toHaveLength(1);
			expect(matches[0]?.description).toBe("Invalid project agent");
			expect(matches[0]?.configurationError).toContain("WebSearch");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("rejects runtime: claude for project .claude agents", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".claude", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"claude-in-claude-dir.md",
			[
				"---",
				"name: claude-in-claude-dir",
				"description: Claude-format project agent with legacy runtime",
				"runtime: claude",
				"model: haiku",
				"---",
				"Do work.",
			].join("\n"),
		);

		const result = discoverAgents(tmpDir);
		const agent = result.agents.find((a) => a.name === "claude-in-claude-dir");
		expect(agent).toBeDefined();
		expect(agent?.configurationError).toContain('runtime "claude" is no longer supported');

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe("prompt injection", () => {
	it("agents include the ask_master guideline and no-recursion rule", () => {
		const tmpDir = createTempAgentDir();
		const agentsDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		writeAgentFile(
			agentsDir,
			"pi-worker.md",
			["---", "name: pi-worker", "description: Pi worker", "---", "Do pi work."].join("\n"),
		);

		const agent = discoverAgents(tmpDir).agents.find((a) => a.name === "pi-worker");
		expect(agent).toBeDefined();
		expect(agent?.systemPrompt).toContain("ask_master Guideline:");
		expect(agent?.systemPrompt).toContain("Global Runtime Rule (subagent):");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});
