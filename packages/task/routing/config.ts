/**
 * Task routing configuration.
 *
 * Sources, lowest precedence first:
 *   1. built-in defaults (derived from the parent session model, see `PRESET_CATALOG`)
 *   2. `<agentDir>/settings.json` → `task` property
 *   3. nearest `.pi/task.json` walking up from `cwd` (either the bare object or `{ "task": { ... } }`)
 *
 * Malformed values are rejected with `TaskConfigError` instead of being dropped, so a typo in a
 * config file never silently downgrades a Task to a different model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelSelection, TaskConfig, TaskTier, ThinkingLevel } from "../types.ts";

export class TaskConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskConfigError";
	}
}

export const TASK_TIERS: readonly TaskTier[] = ["fast", "balanced", "powerful"];
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const DEFAULT_MAX_CONCURRENCY = 4;
/** Upper bound for `maxConcurrency`; one child agent process per running Task. */
export const MAX_CONCURRENCY_LIMIT = 16;
export const DEFAULT_PREFER_CLASSIFIER = false;

/** Thinking level each tier gets when a config entry omits it. */
export const DEFAULT_TIER_THINKING: Record<TaskTier, ThinkingLevel> = {
	fast: "low",
	balanced: "medium",
	powerful: "high",
};

export const PROJECT_CONFIG_RELATIVE_PATH = path.join(".pi", "task.json");
export const GLOBAL_SETTINGS_FILENAME = "settings.json";
export const GLOBAL_SETTINGS_KEY = "task";

export interface ParentModel {
	provider: string;
	id: string;
}

export interface ProviderPresetEntry {
	presets: Record<TaskTier, ModelSelection>;
	evaluator: ModelSelection;
}

const select = (provider: string, model: string, thinking: ThinkingLevel): ModelSelection => ({
	provider,
	model,
	thinking,
});

/**
 * Per-provider defaults. Keys are Pi provider ids and every model id below exists in the Pi 1.1.0
 * catalog for that exact provider. Providers that merely proxy the same families (openrouter,
 * vercel-ai-gateway, github-copilot, amazon-bedrock, ...) use different model ids, so they are not
 * guessed here: see `resolveDefaultPresets`.
 */
export const PRESET_CATALOG: Readonly<Record<string, ProviderPresetEntry>> = {
	"openai-codex": {
		presets: {
			fast: select("openai-codex", "gpt-6-luna", "low"),
			balanced: select("openai-codex", "gpt-6-sol", "medium"),
			powerful: select("openai-codex", "gpt-6-astra", "high"),
		},
		evaluator: select("openai-codex", "gpt-6-luna", "low"),
	},
	openai: {
		presets: {
			fast: select("openai", "gpt-6-luna", "low"),
			balanced: select("openai", "gpt-6-sol", "medium"),
			powerful: select("openai", "gpt-6-astra", "high"),
		},
		evaluator: select("openai", "gpt-6-luna", "low"),
	},
	anthropic: {
		presets: {
			fast: select("anthropic", "claude-haiku-5-5", "low"),
			balanced: select("anthropic", "claude-sonnet-5-5", "medium"),
			powerful: select("anthropic", "claude-opus-5-5", "high"),
		},
		evaluator: select("anthropic", "claude-haiku-5-5", "low"),
	},
};

/** How the built-in presets were derived. Lets the caller warn when explicit config is advisable. */
export type PresetSource = "catalog" | "parent-model";

export interface ResolvedDefaultPresets {
	source: PresetSource;
	provider: string;
	presets: Record<TaskTier, ModelSelection>;
	evaluator: ModelSelection;
}

export function isKnownPresetProvider(provider: string | undefined): boolean {
	return provider !== undefined && Object.hasOwn(PRESET_CATALOG, provider);
}

/**
 * Catalog presets for the parent provider when known. Otherwise every tier reuses the parent model
 * itself and only the thinking level changes: an unknown provider never gets switched to a model id
 * that may not exist there.
 */
export function resolveDefaultPresets(parentModel: ParentModel): ResolvedDefaultPresets {
	const entry = PRESET_CATALOG[parentModel.provider];
	if (entry) {
		return {
			source: "catalog",
			provider: parentModel.provider,
			presets: { ...entry.presets },
			evaluator: { ...entry.evaluator },
		};
	}
	return {
		source: "parent-model",
		provider: parentModel.provider,
		presets: {
			fast: select(parentModel.provider, parentModel.id, DEFAULT_TIER_THINKING.fast),
			balanced: select(parentModel.provider, parentModel.id, DEFAULT_TIER_THINKING.balanced),
			powerful: select(parentModel.provider, parentModel.id, DEFAULT_TIER_THINKING.powerful),
		},
		evaluator: select(parentModel.provider, parentModel.id, "low"),
	};
}

/** Default `evaluatorFallbacks`: one lightweight evaluator per catalog provider. */
export function defaultEvaluatorFallbacks(): Record<string, ModelSelection> {
	const fallbacks: Record<string, ModelSelection> = {};
	for (const [provider, entry] of Object.entries(PRESET_CATALOG)) {
		fallbacks[provider] = { ...entry.evaluator };
	}
	return fallbacks;
}

// ── parsing ──────────────────────────────────────────────────────────────────

interface PartialTaskSettings {
	maxConcurrency?: number;
	preferClassifier?: boolean;
	classifier?: { provider: string; model: string };
	evaluator?: ModelSelection;
	evaluatorFallbacks?: Record<string, ModelSelection>;
	presets?: Partial<Record<TaskTier, ModelSelection>>;
}

const KNOWN_KEYS: readonly string[] = [
	"maxConcurrency",
	"preferClassifier",
	"classifier",
	"evaluator",
	"evaluatorFallbacks",
	"presets",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function fail(source: string, where: string, detail: string): never {
	throw new TaskConfigError(`${source}: ${where} ${detail}`);
}

function parseThinking(value: unknown, source: string, where: string, fallback: ThinkingLevel): ThinkingLevel {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ThinkingLevel)) {
		return fail(source, where, `must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	return value as ThinkingLevel;
}

function parseNonEmptyString(value: unknown, source: string, where: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		return fail(source, where, "must be a non-empty string");
	}
	return value.trim();
}

function parseModelSelection(
	value: unknown,
	source: string,
	where: string,
	defaultThinking: ThinkingLevel,
): ModelSelection {
	if (typeof value === "string") {
		// "provider/model-id" shorthand.
		const slash = value.indexOf("/");
		if (slash <= 0 || slash === value.length - 1) {
			return fail(source, where, 'string form must be "provider/model-id"');
		}
		return {
			provider: value.slice(0, slash).trim(),
			model: value.slice(slash + 1).trim(),
			thinking: defaultThinking,
		};
	}
	if (!isRecord(value))
		return fail(source, where, 'must be an object { provider, model, thinking } or "provider/model"');
	for (const key of Object.keys(value)) {
		if (key !== "provider" && key !== "model" && key !== "thinking") {
			return fail(source, `${where}.${key}`, "is not a known key (provider, model, thinking)");
		}
	}
	return {
		provider: parseNonEmptyString(value.provider, source, `${where}.provider`),
		model: parseNonEmptyString(value.model, source, `${where}.model`),
		thinking: parseThinking(value.thinking, source, `${where}.thinking`, defaultThinking),
	};
}

function parseSettings(raw: unknown, source: string): PartialTaskSettings {
	if (!isRecord(raw)) return fail(source, "task config", "must be a JSON object");
	for (const key of Object.keys(raw)) {
		if (!KNOWN_KEYS.includes(key)) {
			return fail(source, key, `is not a known Task setting (${KNOWN_KEYS.join(", ")})`);
		}
	}

	const parsed: PartialTaskSettings = {};

	if (raw.maxConcurrency !== undefined) {
		const value = raw.maxConcurrency;
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY_LIMIT) {
			fail(source, "maxConcurrency", `must be an integer between 1 and ${MAX_CONCURRENCY_LIMIT}`);
		}
		parsed.maxConcurrency = value;
	}

	if (raw.preferClassifier !== undefined) {
		const value = raw.preferClassifier;
		if (typeof value !== "boolean") fail(source, "preferClassifier", "must be true or false");
		parsed.preferClassifier = value;
	}

	if (raw.classifier !== undefined) {
		const selection = parseModelSelection(raw.classifier, source, "classifier", "off");
		parsed.classifier = { provider: selection.provider, model: selection.model };
	}

	if (raw.evaluator !== undefined) {
		parsed.evaluator = parseModelSelection(raw.evaluator, source, "evaluator", "low");
	}

	if (raw.evaluatorFallbacks !== undefined) {
		const rawFallbacks = raw.evaluatorFallbacks;
		if (!isRecord(rawFallbacks)) fail(source, "evaluatorFallbacks", "must be an object keyed by provider");
		const fallbacks: Record<string, ModelSelection> = {};
		for (const [provider, value] of Object.entries(rawFallbacks)) {
			if (provider.trim() === "") fail(source, "evaluatorFallbacks", "has an empty provider key");
			fallbacks[provider] = parseModelSelection(value, source, `evaluatorFallbacks.${provider}`, "low");
		}
		parsed.evaluatorFallbacks = fallbacks;
	}

	if (raw.presets !== undefined) {
		const rawPresets = raw.presets;
		if (!isRecord(rawPresets)) fail(source, "presets", "must be an object keyed by tier");
		const presets: Partial<Record<TaskTier, ModelSelection>> = {};
		for (const [tier, value] of Object.entries(rawPresets)) {
			if (!TASK_TIERS.includes(tier as TaskTier)) {
				fail(source, `presets.${tier}`, `is not a known tier (${TASK_TIERS.join(", ")})`);
			}
			const typedTier = tier as TaskTier;
			presets[typedTier] = parseModelSelection(value, source, `presets.${tier}`, DEFAULT_TIER_THINKING[typedTier]);
		}
		parsed.presets = presets;
	}

	return parsed;
}

// ── file loading ─────────────────────────────────────────────────────────────

function readJson(file: string): unknown | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
	if (text.trim() === "") return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new TaskConfigError(`${file}: invalid JSON (${reason})`);
	}
}

export function resolveAgentDir(agentDir?: string): string {
	if (agentDir) return agentDir;
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (fromEnv && fromEnv.trim() !== "") {
		const trimmed = fromEnv.trim();
		return trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
	}
	return path.join(os.homedir(), ".pi", "agent");
}

/** Nearest `.pi/task.json` at or above `cwd`, or undefined. */
export function findProjectConfigFile(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, PROJECT_CONFIG_RELATIVE_PATH);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Accepts both the bare settings object and a `{ "task": { ... } }` wrapper. */
function unwrapTaskSection(raw: unknown): unknown {
	if (isRecord(raw) && raw.task !== undefined && !KNOWN_KEYS.some((key) => Object.hasOwn(raw, key))) {
		return raw.task;
	}
	return raw;
}

function mergeSettings(base: PartialTaskSettings, override: PartialTaskSettings): PartialTaskSettings {
	return {
		maxConcurrency: override.maxConcurrency ?? base.maxConcurrency,
		preferClassifier: override.preferClassifier ?? base.preferClassifier,
		classifier: override.classifier ?? base.classifier,
		evaluator: override.evaluator ?? base.evaluator,
		evaluatorFallbacks:
			base.evaluatorFallbacks || override.evaluatorFallbacks
				? { ...base.evaluatorFallbacks, ...override.evaluatorFallbacks }
				: undefined,
		presets: base.presets || override.presets ? { ...base.presets, ...override.presets } : undefined,
	};
}

/**
 * Build the effective Task configuration.
 *
 * `parentModel` is the session model the Task extension runs under; it decides the default presets.
 * Without it, every tier must be configured explicitly.
 */
export function loadTaskConfig(cwd: string, parentModel?: ParentModel, agentDir?: string): TaskConfig {
	const globalFile = path.join(resolveAgentDir(agentDir), GLOBAL_SETTINGS_FILENAME);
	const globalRaw = readJson(globalFile);
	const globalSection = isRecord(globalRaw) ? globalRaw[GLOBAL_SETTINGS_KEY] : undefined;
	const globalSettings = globalSection === undefined ? {} : parseSettings(globalSection, globalFile);

	const projectFile = findProjectConfigFile(cwd);
	const projectRaw = projectFile ? readJson(projectFile) : undefined;
	const projectSettings =
		projectRaw === undefined || projectFile === undefined
			? {}
			: parseSettings(unwrapTaskSection(projectRaw), projectFile);

	const settings = mergeSettings(globalSettings, projectSettings);

	const defaults = parentModel ? resolveDefaultPresets(parentModel) : undefined;
	const presets = {} as Record<TaskTier, ModelSelection>;
	const missing: TaskTier[] = [];
	for (const tier of TASK_TIERS) {
		const configured = settings.presets?.[tier];
		const fallback = defaults?.presets[tier];
		if (configured) presets[tier] = configured;
		else if (fallback) presets[tier] = fallback;
		else missing.push(tier);
	}
	if (missing.length > 0) {
		throw new TaskConfigError(
			`No model preset for tier(s) ${missing.join(", ")}. ` +
				`The parent session model is unknown, so set task.presets in ${path.join(cwd, PROJECT_CONFIG_RELATIVE_PATH)} ` +
				`or in ${globalFile} under "task".`,
		);
	}

	const evaluatorFallbacks = { ...defaultEvaluatorFallbacks(), ...settings.evaluatorFallbacks };
	if (defaults && !Object.hasOwn(evaluatorFallbacks, defaults.provider)) {
		evaluatorFallbacks[defaults.provider] = { ...defaults.evaluator };
	}

	return {
		maxConcurrency: settings.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
		preferClassifier: settings.preferClassifier ?? DEFAULT_PREFER_CLASSIFIER,
		classifier: settings.classifier,
		evaluator: settings.evaluator ?? defaults?.evaluator,
		evaluatorFallbacks,
		presets,
	};
}
