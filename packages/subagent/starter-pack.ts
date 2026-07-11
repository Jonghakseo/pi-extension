import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AgentDiscoveryResult, discoverAgents } from "./agents.js";

export const STARTER_AGENT_NAMES = [
	"browser",
	"challenger",
	"code-cleaner",
	"reviewer",
	"searcher",
	"security-auditor",
	"simplifier",
	"verifier",
	"worker",
] as const;

export const STARTER_SKILL_NAMES = ["self-healing", "stress-interview"] as const;

const STARTER_SUBAGENT_SETTINGS = {
	defaultAgent: "worker",
	claudeRuntime: "cli",
	symbolMap: {
		"?": "searcher",
		"!": "challenger",
		"@": "browser",
	},
} as const;

interface StarterPackPaths {
	agentDir: string;
	seedRoot: string;
	settingsPath: string;
}

export interface StarterPackInstallResult {
	createdAgents: string[];
	skippedAgents: string[];
	createdSkills: string[];
	skippedSkills: string[];
	settingsUpdated: boolean;
}

export type StarterPackOfferStatus = "not-needed" | "headless" | "declined" | "installed" | "failed";

export interface StarterPackOfferResult {
	status: StarterPackOfferStatus;
	discovery: AgentDiscoveryResult;
	installResult?: StarterPackInstallResult;
	error?: string;
}

export interface StarterPackPromptContext {
	cwd: string;
	hasUI?: boolean;
	ui?: {
		confirm?: (title: string, message: string) => Promise<boolean>;
	};
}

interface StarterPackOptions {
	agentDir?: string;
	seedRoot?: string;
	discover?: (cwd: string) => AgentDiscoveryResult;
}

interface SettingsPlan {
	settings: Record<string, unknown>;
	updated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePaths(options: StarterPackOptions = {}): StarterPackPaths {
	const agentDir = options.agentDir ?? getAgentDir();
	return {
		agentDir,
		seedRoot: options.seedRoot ?? fileURLToPath(new URL("./seeds", import.meta.url)),
		settingsPath: path.join(agentDir, "settings.json"),
	};
}

function readSettingsPlan(settingsPath: string): SettingsPlan {
	let settings: Record<string, unknown> = {};
	if (fs.existsSync(settingsPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
			if (!isRecord(parsed)) throw new Error("settings root must be a JSON object");
			settings = parsed;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Cannot seed starter pack because settings.json is invalid: ${message}`);
		}
	}

	const existingSubagent = isRecord(settings.subagent) ? settings.subagent : {};
	const mergedSubagent: Record<string, unknown> = { ...existingSubagent };
	let updated = !isRecord(settings.subagent);

	for (const [key, value] of Object.entries(STARTER_SUBAGENT_SETTINGS)) {
		if (Object.hasOwn(mergedSubagent, key)) continue;
		mergedSubagent[key] = value;
		updated = true;
	}

	if (updated) {
		settings = { ...settings, subagent: mergedSubagent };
	}
	return { settings, updated };
}

function validateSeedFiles(seedRoot: string): void {
	const expected = [
		...STARTER_AGENT_NAMES.map((name) => path.join(seedRoot, "agents", `${name}.md`)),
		...STARTER_SKILL_NAMES.map((name) => path.join(seedRoot, "skills", name, "SKILL.md")),
	];
	for (const filePath of expected) {
		if (!fs.statSync(filePath).isFile()) {
			throw new Error(`Starter pack seed file is missing: ${filePath}`);
		}
	}
}

function copyWithoutOverwrite(source: string, destination: string): "created" | "skipped" {
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	try {
		fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
		return "created";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "skipped";
		throw error;
	}
}

function writeSettingsAtomically(settingsPath: string, settings: Record<string, unknown>): void {
	let targetPath = settingsPath;
	try {
		if (fs.lstatSync(settingsPath).isSymbolicLink()) {
			targetPath = fs.realpathSync(settingsPath);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	const mode = fs.existsSync(targetPath) ? fs.statSync(targetPath).mode & 0o777 : 0o600;
	const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, "\t")}\n`, { encoding: "utf8", mode });
		fs.renameSync(tempPath, targetPath);
	} finally {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// The rename already consumed the temporary file or creation failed.
		}
	}
}

export function installStarterPack(options: StarterPackOptions = {}): StarterPackInstallResult {
	const paths = resolvePaths(options);
	const settingsPlan = readSettingsPlan(paths.settingsPath);
	validateSeedFiles(paths.seedRoot);

	const result: StarterPackInstallResult = {
		createdAgents: [],
		skippedAgents: [],
		createdSkills: [],
		skippedSkills: [],
		settingsUpdated: settingsPlan.updated,
	};
	const createdPaths: string[] = [];

	try {
		for (const name of STARTER_AGENT_NAMES) {
			const destination = path.join(paths.agentDir, "agents", `${name}.md`);
			const outcome = copyWithoutOverwrite(path.join(paths.seedRoot, "agents", `${name}.md`), destination);
			result[outcome === "created" ? "createdAgents" : "skippedAgents"].push(name);
			if (outcome === "created") createdPaths.push(destination);
		}

		for (const name of STARTER_SKILL_NAMES) {
			const destination = path.join(paths.agentDir, "skills", name, "SKILL.md");
			const outcome = copyWithoutOverwrite(path.join(paths.seedRoot, "skills", name, "SKILL.md"), destination);
			result[outcome === "created" ? "createdSkills" : "skippedSkills"].push(name);
			if (outcome === "created") createdPaths.push(destination);
		}

		if (settingsPlan.updated) {
			writeSettingsAtomically(paths.settingsPath, settingsPlan.settings);
		}
	} catch (error) {
		for (const filePath of createdPaths.reverse()) {
			try {
				fs.unlinkSync(filePath);
			} catch {
				// Preserve the original error; only files created by this attempt are rollback candidates.
			}
		}
		throw error;
	}

	return result;
}

export async function offerStarterPackIfEmpty(
	ctx: StarterPackPromptContext,
	options: StarterPackOptions = {},
): Promise<StarterPackOfferResult> {
	const discover = options.discover ?? discoverAgents;
	let discovery = discover(ctx.cwd);
	if (discovery.agents.length > 0) return { status: "not-needed", discovery };

	if (!ctx.hasUI || !ctx.ui?.confirm) {
		return { status: "headless", discovery };
	}

	const accepted = await ctx.ui.confirm(
		"Install starter subagents?",
		"No subagent definitions were found. Install 9 portable English agents, the stress-interview and self-healing skills, and missing subagent settings? Existing files and configured values will not be overwritten.",
	);
	if (!accepted) return { status: "declined", discovery };

	try {
		const installResult = installStarterPack(options);
		discovery = discover(ctx.cwd);
		if (discovery.agents.length === 0) {
			return {
				status: "failed",
				discovery,
				installResult,
				error: "Starter files were copied, but no valid agent definitions were discovered.",
			};
		}
		return { status: "installed", discovery, installResult };
	} catch (error) {
		return {
			status: "failed",
			discovery,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function formatStarterPackNotice(result: StarterPackOfferResult): string | undefined {
	switch (result.status) {
		case "installed":
			return "Starter pack installed. Agents and subagent settings are ready now; run /reload to activate the stress-interview and self-healing skills.";
		case "headless":
			return "No subagents found. Run /subagents in an interactive Pi session to install the optional starter pack.";
		case "declined":
			return "No subagents found. Starter pack installation was declined.";
		case "failed":
			return `Starter pack installation failed: ${result.error ?? "unknown error"}`;
		default:
			return undefined;
	}
}
