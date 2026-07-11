import * as fs from "node:fs";
import * as path from "node:path";
import { mapPiToolsToClaude } from "./utils/agent-utils.js";

export interface ClaudeArgsConfig {
	prompt: string;
	tools: string[];
	model?: string;
	thinking?: string;
	resumeSessionId?: string;
	cwd?: string;
	mcpConfigPath?: string;
	systemPromptFile?: string;
}

const MCP_CONFIG_CANDIDATES = [".mcp.json"] as const;

export function mapThinkingToClaudeEffort(piThinking: string): "low" | "medium" | "high" | "max" | undefined {
	switch (piThinking) {
		case "off":
		case "minimal":
			return "low";
		case "low":
			return "medium";
		case "medium":
			return "high";
		case "high":
		case "xhigh":
			return "max";
		case "max":
			return "max";
		default:
			return undefined;
	}
}

export function findProjectMcpConfig(cwd: string): string | undefined {
	let currentDir = path.resolve(cwd);

	while (true) {
		for (const candidate of MCP_CONFIG_CANDIDATES) {
			const fullPath = path.join(currentDir, candidate);
			try {
				if (fs.statSync(fullPath).isFile()) return fullPath;
			} catch {}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
}

export function buildClaudeArgs(config: ClaudeArgsConfig): string[] {
	const args: string[] = [
		"-p",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		"--verbose",
		"--dangerously-skip-permissions",
	];

	const claudeTools = mapPiToolsToClaude(config.tools);

	if (claudeTools.length > 0) {
		args.push("--tools", claudeTools.join(","));
		args.push("--allowedTools", claudeTools.join(","));
	}

	args.push("--strict-mcp-config");

	if (config.mcpConfigPath) {
		args.push("--mcp-config", config.mcpConfigPath);
	} else if (config.cwd) {
		const discovered = findProjectMcpConfig(config.cwd);
		if (discovered) {
			args.push("--mcp-config", discovered);
		}
	}

	if (config.model) {
		const normalized = config.model.replace(/^anthropic\//, "");
		args.push("--model", normalized);
	}

	if (config.thinking) {
		const effort = mapThinkingToClaudeEffort(config.thinking);
		if (effort) args.push("--effort", effort);
	}

	if (config.resumeSessionId) {
		args.push("--resume", config.resumeSessionId);
	}

	if (config.systemPromptFile) {
		args.push("--append-system-prompt-file", config.systemPromptFile);
	}

	args.push(config.prompt);

	return args;
}
