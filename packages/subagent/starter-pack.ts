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

export type StarterPackOfferStatus =
	| "not-needed"
	| "headless"
	| "declined"
	| "installed"
	| "failed"
	| "skills-headless"
	| "skills-declined"
	| "skills-installed";

export interface StarterPackOfferResult {
	status: StarterPackOfferStatus;
	discovery: AgentDiscoveryResult;
	installResult?: StarterPackInstallResult;
	missingSkills?: string[];
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

type InstallScope = "all" | "skills";

interface CreatedPaths {
	files: string[];
	dirs: string[];
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

function validateSeedFiles(seedRoot: string, scope: InstallScope): void {
	const expected =
		scope === "skills"
			? STARTER_SKILL_NAMES.map((name) => path.join(seedRoot, "skills", name, "SKILL.md"))
			: [
					...STARTER_AGENT_NAMES.map((name) => path.join(seedRoot, "agents", `${name}.md`)),
					...STARTER_SKILL_NAMES.map((name) => path.join(seedRoot, "skills", name, "SKILL.md")),
				];
	for (const filePath of expected) {
		if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
			throw new Error(`Starter pack seed file is missing: ${filePath}`);
		}
	}
}

function ensureDir(dir: string, created: CreatedPaths): void {
	if (fs.existsSync(dir)) return;
	const parent = path.dirname(dir);
	if (parent !== dir) ensureDir(parent, created);
	fs.mkdirSync(dir);
	created.dirs.push(dir);
}

function copyWithoutOverwrite(source: string, destination: string, created: CreatedPaths): "created" | "skipped" {
	ensureDir(path.dirname(destination), created);
	try {
		fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
		created.files.push(destination);
		return "created";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "skipped";
		throw error;
	}
}

/** Copies every seed file of one skill, so references and scripts added later are not silently dropped. */
function copySkillWithoutOverwrite(sourceDir: string, destinationDir: string, created: CreatedPaths): void {
	ensureDir(destinationDir, created);
	for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
		const source = path.join(sourceDir, entry.name);
		const destination = path.join(destinationDir, entry.name);
		if (entry.isDirectory()) copySkillWithoutOverwrite(source, destination, created);
		else if (entry.isFile()) copyWithoutOverwrite(source, destination, created);
	}
}

function skillInstallPath(agentDir: string, name: string): string {
	return path.join(agentDir, "skills", name, "SKILL.md");
}

/** Starter skills whose `SKILL.md` is absent, so an existing user skill of the same name is never touched. */
export function findMissingStarterSkills(options: StarterPackOptions = {}): string[] {
	const { agentDir } = resolvePaths(options);
	return STARTER_SKILL_NAMES.filter((name) => !fs.existsSync(skillInstallPath(agentDir, name)));
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

function rollback(created: CreatedPaths): void {
	for (const filePath of [...created.files].reverse()) {
		try {
			fs.unlinkSync(filePath);
		} catch {
			// Preserve the original error; only paths created by this attempt are rollback candidates.
		}
	}
	for (const dirPath of [...created.dirs].reverse()) {
		try {
			fs.rmdirSync(dirPath);
		} catch {
			// A non-empty directory holds files this attempt did not create, so it stays.
		}
	}
}

function install(scope: InstallScope, options: StarterPackOptions): StarterPackInstallResult {
	const paths = resolvePaths(options);
	const settingsPlan = scope === "all" ? readSettingsPlan(paths.settingsPath) : undefined;
	validateSeedFiles(paths.seedRoot, scope);

	const result: StarterPackInstallResult = {
		createdAgents: [],
		skippedAgents: [],
		createdSkills: [],
		skippedSkills: [],
		settingsUpdated: settingsPlan?.updated ?? false,
	};
	const created: CreatedPaths = { files: [], dirs: [] };

	try {
		if (scope === "all") {
			for (const name of STARTER_AGENT_NAMES) {
				const destination = path.join(paths.agentDir, "agents", `${name}.md`);
				const outcome = copyWithoutOverwrite(path.join(paths.seedRoot, "agents", `${name}.md`), destination, created);
				result[outcome === "created" ? "createdAgents" : "skippedAgents"].push(name);
			}
		}

		for (const name of STARTER_SKILL_NAMES) {
			if (fs.existsSync(skillInstallPath(paths.agentDir, name))) {
				result.skippedSkills.push(name);
				continue;
			}
			copySkillWithoutOverwrite(
				path.join(paths.seedRoot, "skills", name),
				path.join(paths.agentDir, "skills", name),
				created,
			);
			result.createdSkills.push(name);
		}

		if (settingsPlan?.updated) {
			writeSettingsAtomically(paths.settingsPath, settingsPlan.settings);
		}
	} catch (error) {
		rollback(created);
		throw error;
	}

	return result;
}

export function installStarterPack(options: StarterPackOptions = {}): StarterPackInstallResult {
	return install("all", options);
}

/** Installs only the starter skills, for users who already have their own agents. */
export function installStarterSkills(options: StarterPackOptions = {}): StarterPackInstallResult {
	return install("skills", options);
}

export async function offerStarterPackIfEmpty(
	ctx: StarterPackPromptContext,
	options: StarterPackOptions = {},
): Promise<StarterPackOfferResult> {
	const discover = options.discover ?? discoverAgents;
	let discovery = discover(ctx.cwd);
	if (discovery.agents.length > 0) return await offerMissingSkills(ctx, options, discovery);

	if (!ctx.hasUI || !ctx.ui?.confirm) {
		return { status: "headless", discovery };
	}

	const accepted = await ctx.ui.confirm(
		"Install starter subagents?",
		"No subagent definitions were found. Install 8 portable English agents, the stress-interview and self-healing skills, and missing subagent settings? Existing files and configured values will not be overwritten.",
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

/**
 * Users who already defined agents never see the pack offer, so the starter skills alone stay unreachable.
 * This offers just the missing ones and leaves existing agents and settings untouched.
 */
async function offerMissingSkills(
	ctx: StarterPackPromptContext,
	options: StarterPackOptions,
	discovery: AgentDiscoveryResult,
): Promise<StarterPackOfferResult> {
	const missingSkills = findMissingStarterSkills(options);
	if (missingSkills.length === 0) return { status: "not-needed", discovery };

	if (!ctx.hasUI || !ctx.ui?.confirm) {
		return { status: "skills-headless", discovery, missingSkills };
	}

	const accepted = await ctx.ui.confirm(
		"Install missing subagent workflow skills?",
		`Your agents are already set up, but these optional workflow skills are missing: ${missingSkills.join(", ")}. Install them? Existing files and settings will not be overwritten.`,
	);
	if (!accepted) return { status: "skills-declined", discovery, missingSkills };

	try {
		const installResult = installStarterSkills(options);
		return { status: "skills-installed", discovery, installResult, missingSkills };
	} catch (error) {
		return {
			status: "failed",
			discovery,
			missingSkills,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function formatStarterPackNotice(result: StarterPackOfferResult): string | undefined {
	const missing = result.missingSkills?.join(", ") ?? "";
	switch (result.status) {
		case "skills-installed":
			return `Missing workflow skills installed: ${result.installResult?.createdSkills.join(", ") ?? missing}. Run /reload to activate them.`;
		case "skills-declined":
			return `Optional workflow skills are still missing: ${missing}. Installation was declined.`;
		case "skills-headless":
			return `Optional workflow skills are missing: ${missing}. Run /subagents in an interactive Pi session to install them.`;
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
