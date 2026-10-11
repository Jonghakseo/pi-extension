import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findNearestProjectSubagentConfig, loadSubagentConfig } from "./config.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-config-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("subagent config", () => {
	it("uses defaults when config is missing", () => {
		const tmpDir = createTempDir();

		expect(loadSubagentConfig(tmpDir, { globalPath: null, projectPath: null })).toEqual({
			defaultAgent: "worker",
			symbolMap: {},
		});
	});

	it("finds the nearest project .pi/subagent.json", () => {
		const tmpDir = createTempDir();
		const configPath = path.join(tmpDir, ".pi", "subagent.json");
		const nestedDir = path.join(tmpDir, "apps", "web", "src");
		fs.mkdirSync(nestedDir, { recursive: true });
		writeJson(configPath, { defaultAgent: "reviewer", symbolMap: {} });

		expect(findNearestProjectSubagentConfig(nestedDir)).toBe(configPath);
		expect(loadSubagentConfig(nestedDir, { globalPath: null })).toEqual({
			defaultAgent: "reviewer",
			symbolMap: {},
		});
	});

	it("loads symbolMap and lets project config replace the global map", () => {
		const tmpDir = createTempDir();
		const globalPath = path.join(tmpDir, "settings.json");
		const projectPath = path.join(tmpDir, ".pi", "subagent.json");
		writeJson(globalPath, { subagent: { symbolMap: { "?": "searcher" } } });
		writeJson(projectPath, { symbolMap: { "!": "reviewer" } });

		expect(loadSubagentConfig(tmpDir, { globalPath })).toEqual({
			defaultAgent: "worker",
			symbolMap: { "!": "reviewer" },
		});
	});

	it("loads and overrides defaultAgent", () => {
		const tmpDir = createTempDir();
		const globalPath = path.join(tmpDir, "settings.json");
		const projectPath = path.join(tmpDir, ".pi", "subagent.json");
		writeJson(globalPath, { subagent: { defaultAgent: "worker" } });
		writeJson(projectPath, { defaultAgent: "reviewer" });

		expect(loadSubagentConfig(tmpDir, { globalPath })).toMatchObject({ defaultAgent: "reviewer" });
	});

	it.each([null, [], "?", 1])("rejects non-object symbolMap %j", (symbolMap) => {
		const tmpDir = createTempDir();
		const projectPath = path.join(tmpDir, ".pi", "subagent.json");
		writeJson(projectPath, { symbolMap });

		expect(loadSubagentConfig(tmpDir, { globalPath: null }).symbolMap).toEqual({});
	});

	it.each([
		{ invalid: "worker" },
		{ "?": 42 },
		{ "?": "   " },
		{ "?": "searcher", invalid: "worker" },
	])("rejects the entire malformed symbolMap %j", (symbolMap) => {
		const tmpDir = createTempDir();
		const globalPath = path.join(tmpDir, "settings.json");
		const projectPath = path.join(tmpDir, ".pi", "subagent.json");
		writeJson(globalPath, { subagent: { symbolMap: { "!": "reviewer" } } });
		writeJson(projectPath, { symbolMap });

		expect(loadSubagentConfig(tmpDir, { globalPath }).symbolMap).toEqual({ "!": "reviewer" });
	});

	it("ignores the removed claudeRuntime setting", () => {
		const tmpDir = createTempDir();
		const projectPath = path.join(tmpDir, ".pi", "subagent.json");
		writeJson(projectPath, { claudeRuntime: "weird" });

		expect(loadSubagentConfig(tmpDir, { globalPath: null })).toEqual({
			defaultAgent: "worker",
			symbolMap: {},
		});
	});
});
