import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ClaudeRuntimeMode = "sdk" | "cli";

export interface SubagentConfig {
	claudeRuntime: ClaudeRuntimeMode;
	defaultAgent: string;
	symbolMap: Record<string, string>;
}

interface RawSubagentConfig {
	claudeRuntime?: unknown;
	defaultAgent?: unknown;
	symbolMap?: unknown;
}

interface RawSettingsFile extends RawSubagentConfig {
	subagent?: RawSubagentConfig;
}

interface LoadSubagentConfigOptions {
	globalPath?: string | null;
	projectPath?: string | null;
}

const DEFAULT_CONFIG: SubagentConfig = {
	claudeRuntime: "sdk",
	defaultAgent: "worker",
	symbolMap: {},
};

function isFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function normalizeClaudeRuntime(value: unknown): ClaudeRuntimeMode | undefined {
	return value === "cli" || value === "sdk" ? value : undefined;
}

function normalizeDefaultAgent(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeSymbolMap(value: unknown): Record<string, string> | undefined {
	if (typeof value !== "object" || !value || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	if (
		entries.some(([symbol, agent]) => symbol.length !== 1 || typeof agent !== "string" || agent.trim().length === 0)
	) {
		return undefined;
	}
	return Object.fromEntries(entries.map(([symbol, agent]) => [symbol, (agent as string).trim()]));
}

function extractSubagentConfig(value: unknown): RawSubagentConfig {
	if (typeof value !== "object" || !value) return {};
	const parsed = value as RawSettingsFile;
	if (typeof parsed.subagent === "object" && parsed.subagent) return parsed.subagent;
	return parsed;
}

function readConfigFile(filePath: string | null | undefined): RawSubagentConfig {
	if (!filePath || !existsSync(filePath) || !isFile(filePath)) return {};

	try {
		const raw = readFileSync(filePath, "utf-8");
		return extractSubagentConfig(JSON.parse(raw) as unknown);
	} catch {
		return {};
	}
}

export function findNearestProjectSubagentConfig(cwd: string): string | null {
	let currentDir = cwd;

	while (true) {
		const candidate = join(currentDir, ".pi", "subagent.json");
		if (isFile(candidate)) return candidate;

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function loadSubagentConfig(cwd: string, options: LoadSubagentConfigOptions = {}): SubagentConfig {
	const globalPath = options.globalPath === undefined ? join(getAgentDir(), "settings.json") : options.globalPath;
	const projectPath = options.projectPath === undefined ? findNearestProjectSubagentConfig(cwd) : options.projectPath;

	const globalConfig = readConfigFile(globalPath);
	const projectConfig = readConfigFile(projectPath);
	const claudeRuntime =
		normalizeClaudeRuntime(projectConfig.claudeRuntime) ??
		normalizeClaudeRuntime(globalConfig.claudeRuntime) ??
		DEFAULT_CONFIG.claudeRuntime;

	const defaultAgent =
		normalizeDefaultAgent(projectConfig.defaultAgent) ??
		normalizeDefaultAgent(globalConfig.defaultAgent) ??
		DEFAULT_CONFIG.defaultAgent;
	const globalSymbolMap = normalizeSymbolMap(globalConfig.symbolMap);
	const projectSymbolMap = normalizeSymbolMap(projectConfig.symbolMap);

	return {
		claudeRuntime,
		defaultAgent,
		symbolMap: projectSymbolMap ?? globalSymbolMap ?? DEFAULT_CONFIG.symbolMap,
	};
}

export function resolveClaudeRuntimeMode(cwd: string, options?: LoadSubagentConfigOptions): ClaudeRuntimeMode {
	return loadSubagentConfig(cwd, options).claudeRuntime;
}
