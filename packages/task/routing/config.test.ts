import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_CONCURRENCY,
	findProjectConfigFile,
	loadTaskConfig,
	MAX_CONCURRENCY_LIMIT,
	PRESET_CATALOG,
	resolveDefaultPresets,
	TaskConfigError,
} from "./config.ts";

const CODEX_PARENT = { provider: "openai-codex", id: "gpt-6-sol" };

let root: string;
let agentDir: string;
let projectDir: string;

const writeGlobal = (value: unknown): void => {
	fs.writeFileSync(path.join(agentDir, "settings.json"), typeof value === "string" ? value : JSON.stringify(value));
};

const writeProject = (value: unknown): void => {
	fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, ".pi", "task.json"),
		typeof value === "string" ? value : JSON.stringify(value),
	);
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "task-config-"));
	agentDir = path.join(root, "agent");
	projectDir = path.join(root, "repo", "packages", "app");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("loadTaskConfig defaults", () => {
	it("derives presets from the parent provider catalog", () => {
		const config = loadTaskConfig(projectDir, CODEX_PARENT, agentDir);

		expect(config.presets).toEqual(PRESET_CATALOG["openai-codex"].presets);
		expect(config.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
		expect(config.preferClassifier).toBe(false);
		expect(config.classifier).toBeUndefined();
		expect(config.evaluator).toEqual(PRESET_CATALOG["openai-codex"].evaluator);
		expect(config.evaluatorFallbacks.anthropic).toEqual(PRESET_CATALOG.anthropic.evaluator);
	});

	it("uses the Claude catalog for an anthropic parent", () => {
		const config = loadTaskConfig(projectDir, { provider: "anthropic", id: "claude-sonnet-5-5" }, agentDir);

		expect(config.presets.fast.model).toBe("claude-haiku-5-5");
		expect(config.presets.powerful.model).toBe("claude-opus-5-5");
	});

	it("keeps the parent model for an unsupported provider instead of guessing ids", () => {
		const resolved = resolveDefaultPresets({ provider: "openrouter", id: "some/model" });

		expect(resolved.source).toBe("parent-model");
		expect(new Set(Object.values(resolved.presets).map((preset) => preset.model))).toEqual(new Set(["some/model"]));
		expect(Object.values(resolved.presets).map((preset) => preset.thinking)).toEqual(["low", "medium", "high"]);
	});

	it("demands explicit presets when the parent model is unknown", () => {
		expect(() => loadTaskConfig(projectDir, undefined, agentDir)).toThrow(TaskConfigError);
		expect(() => loadTaskConfig(projectDir, undefined, agentDir)).toThrow(/fast, balanced, powerful/);

		writeProject({
			presets: {
				fast: "openai/gpt-5-mini",
				balanced: "openai/gpt-5.2",
				powerful: { provider: "openai", model: "gpt-5.2-pro", thinking: "xhigh" },
			},
		});
		const config = loadTaskConfig(projectDir, undefined, agentDir);
		expect(config.presets.fast).toEqual({ provider: "openai", model: "gpt-5-mini", thinking: "low" });
		expect(config.presets.powerful.thinking).toBe("xhigh");
	});
});

describe("loadTaskConfig merging", () => {
	it("lets the project config override global settings per key", () => {
		writeGlobal({
			task: {
				maxConcurrency: 2,
				preferClassifier: true,
				presets: { fast: { provider: "anthropic", model: "claude-haiku-5-5", thinking: "minimal" } },
			},
		});
		writeProject({ maxConcurrency: 6 });

		const config = loadTaskConfig(projectDir, CODEX_PARENT, agentDir);

		expect(config.maxConcurrency).toBe(6);
		expect(config.preferClassifier).toBe(true);
		expect(config.presets.fast).toEqual({ provider: "anthropic", model: "claude-haiku-5-5", thinking: "minimal" });
		expect(config.presets.balanced).toEqual(PRESET_CATALOG["openai-codex"].presets.balanced);
	});

	it("accepts a project file wrapped in a task property", () => {
		writeProject({ task: { maxConcurrency: 3 } });
		expect(loadTaskConfig(projectDir, CODEX_PARENT, agentDir).maxConcurrency).toBe(3);
	});

	it("finds the nearest .pi/task.json walking up from cwd", () => {
		const repo = path.join(root, "repo");
		fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".pi", "task.json"), JSON.stringify({ maxConcurrency: 7 }));

		expect(findProjectConfigFile(projectDir)).toBe(path.join(repo, ".pi", "task.json"));
		expect(loadTaskConfig(projectDir, CODEX_PARENT, agentDir).maxConcurrency).toBe(7);

		writeProject({ maxConcurrency: 1 });
		expect(loadTaskConfig(projectDir, CODEX_PARENT, agentDir).maxConcurrency).toBe(1);
	});

	it("merges evaluator fallbacks over the defaults", () => {
		writeProject({ evaluatorFallbacks: { anthropic: "anthropic/claude-haiku-4-5" } });
		const config = loadTaskConfig(projectDir, CODEX_PARENT, agentDir);

		expect(config.evaluatorFallbacks.anthropic).toEqual({
			provider: "anthropic",
			model: "claude-haiku-4-5",
			thinking: "low",
		});
		expect(config.evaluatorFallbacks["openai-codex"]).toEqual(PRESET_CATALOG["openai-codex"].evaluator);
	});
});

describe("loadTaskConfig validation", () => {
	it("ignores missing and empty files", () => {
		expect(() => loadTaskConfig(projectDir, CODEX_PARENT, agentDir)).not.toThrow();
		writeGlobal("");
		expect(() => loadTaskConfig(projectDir, CODEX_PARENT, agentDir)).not.toThrow();
	});

	it("reports the offending file for invalid JSON", () => {
		writeProject("{ not json");
		expect(() => loadTaskConfig(projectDir, CODEX_PARENT, agentDir)).toThrow(/task\.json: invalid JSON/);
	});

	it.each([
		[{ maxConcurrency: 0 }, /maxConcurrency/],
		[{ maxConcurrency: MAX_CONCURRENCY_LIMIT + 1 }, /maxConcurrency/],
		[{ maxConcurrency: 1.5 }, /maxConcurrency/],
		[{ preferClassifier: "yes" }, /preferClassifier/],
		[{ presets: { turbo: "openai/gpt-5-mini" } }, /presets\.turbo/],
		[{ presets: { fast: { provider: "openai", model: "x", thinking: "insane" } } }, /presets\.fast\.thinking/],
		[{ presets: { fast: { provider: "openai" } } }, /presets\.fast\.model/],
		[{ presets: { fast: "gpt-5-mini" } }, /presets\.fast/],
		[{ evaluator: 42 }, /evaluator/],
		[{ typo: true }, /typo/],
	])("rejects malformed config %#", (value, pattern) => {
		writeProject(value);
		expect(() => loadTaskConfig(projectDir, CODEX_PARENT, agentDir)).toThrow(TaskConfigError);
		expect(() => loadTaskConfig(projectDir, CODEX_PARENT, agentDir)).toThrow(pattern);
	});
});
