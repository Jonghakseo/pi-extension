/** biome-ignore-all lint/suspicious/noExplicitAny: tests use temporary Pi directories and lightweight UI mocks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installStarterPack, offerStarterPackIfEmpty } from "./starter-pack.ts";

const AGENT_NAMES = [
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

function readJson(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("subagent starter pack", () => {
	let tmpDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-starter-pack-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("installs nine portable English agents, two skills, and missing subagent settings", () => {
		const result = installStarterPack();

		expect(result.createdAgents).toEqual(AGENT_NAMES);
		expect(result.createdSkills).toEqual(["self-healing", "stress-interview"]);
		for (const name of AGENT_NAMES) {
			const content = fs.readFileSync(path.join(tmpDir, "agents", `${name}.md`), "utf8");
			expect(content).not.toMatch(/^model:/m);
			expect(content).not.toMatch(/[가-힣]/);
		}
		for (const name of ["self-healing", "stress-interview"]) {
			const content = fs.readFileSync(path.join(tmpDir, "skills", name, "SKILL.md"), "utf8");
			expect(content).not.toMatch(/[가-힣]/);
		}

		expect(fs.statSync(path.join(tmpDir, "settings.json")).mode & 0o777).toBe(0o600);
		expect(readJson(path.join(tmpDir, "settings.json")).subagent).toEqual({
			defaultAgent: "worker",
			claudeRuntime: "cli",
			symbolMap: { "?": "searcher", "!": "challenger", "@": "browser" },
		});
		expect(result.settingsUpdated).toBe(true);
	});

	it("never overwrites existing agents, skills, or configured subagent values", () => {
		fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "agents", "worker.md"), "custom worker\n", "utf8");
		fs.mkdirSync(path.join(tmpDir, "skills", "stress-interview"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "skills", "stress-interview", "SKILL.md"), "custom skill\n", "utf8");
		fs.writeFileSync(
			path.join(tmpDir, "settings.json"),
			JSON.stringify({
				theme: "dark",
				subagent: { claudeRuntime: "sdk", symbolMap: {}, customFlag: true },
			}),
			"utf8",
		);

		const result = installStarterPack();
		const settings = readJson(path.join(tmpDir, "settings.json"));

		expect(fs.readFileSync(path.join(tmpDir, "agents", "worker.md"), "utf8")).toBe("custom worker\n");
		expect(fs.readFileSync(path.join(tmpDir, "skills", "stress-interview", "SKILL.md"), "utf8")).toBe("custom skill\n");
		expect(result.skippedAgents).toContain("worker");
		expect(result.skippedSkills).toContain("stress-interview");
		expect(settings.theme).toBe("dark");
		expect(settings.subagent).toEqual({
			claudeRuntime: "sdk",
			symbolMap: {},
			customFlag: true,
			defaultAgent: "worker",
		});
	});

	it("preserves settings file permissions and a dotfiles symlink", () => {
		if (process.platform === "win32") return;
		const targetDir = path.join(tmpDir, "dotfiles");
		const targetPath = path.join(targetDir, "settings.json");
		const settingsPath = path.join(tmpDir, "settings.json");
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(targetPath, JSON.stringify({ theme: "dark" }), { encoding: "utf8", mode: 0o600 });
		fs.symlinkSync(targetPath, settingsPath);

		installStarterPack();

		expect(fs.lstatSync(settingsPath).isSymbolicLink()).toBe(true);
		expect(fs.statSync(targetPath).mode & 0o777).toBe(0o600);
		expect(readJson(targetPath).subagent.defaultAgent).toBe("worker");
	});

	it("does not write any seed files when settings.json is invalid", () => {
		fs.writeFileSync(path.join(tmpDir, "settings.json"), "{ invalid", "utf8");

		expect(() => installStarterPack()).toThrow(/settings\.json/i);
		expect(fs.existsSync(path.join(tmpDir, "agents"))).toBe(false);
		expect(fs.existsSync(path.join(tmpDir, "skills"))).toBe(false);
	});

	it("asks again after a decline and installs after later acceptance", async () => {
		const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const ctx = { cwd: tmpDir, hasUI: true, ui: { confirm } };

		const first = await offerStarterPackIfEmpty(ctx as any);
		const second = await offerStarterPackIfEmpty(ctx as any);

		expect(first.status).toBe("declined");
		expect(second.status).toBe("installed");
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(second.discovery.agents).toHaveLength(9);
	});

	it("does not prompt when an agent already exists", async () => {
		installStarterPack();
		const confirm = vi.fn();

		const result = await offerStarterPackIfEmpty({ cwd: tmpDir, hasUI: true, ui: { confirm } });

		expect(result.status).toBe("not-needed");
		expect(result.discovery.agents).toHaveLength(9);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("does not install or prompt in headless mode", async () => {
		const confirm = vi.fn();
		const result = await offerStarterPackIfEmpty({ cwd: tmpDir, hasUI: false, ui: { confirm } } as any);

		expect(result.status).toBe("headless");
		expect(result.discovery.agents).toHaveLength(0);
		expect(confirm).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(tmpDir, "agents"))).toBe(false);
	});
});
