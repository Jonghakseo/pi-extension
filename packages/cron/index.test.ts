/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerCron from "./index.ts";
import { findJob, saveJobs } from "./store.ts";
import type { CronJob } from "./types.ts";

function createPi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	return {
		tools,
		commands,
		pi: {
			registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
			registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		},
	};
}

function makeJob(root: string, id: string): CronJob {
	const now = new Date().toISOString();
	return {
		id,
		name: id,
		enabled: true,
		kind: "cron",
		once: false,
		schedule: "0 10 * * *",
		timezone: "Asia/Seoul",
		cwd: root,
		promptFile: path.join(root, "cron", "prompts", `${id}.md`),
		createdAt: now,
		updatedAt: now,
	};
}

describe("cron job removal", () => {
	let tmpDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-remove-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function makeCtx(hasUI: boolean) {
		return {
			cwd: tmpDir,
			hasUI,
			ui: {
				confirm: vi.fn().mockResolvedValue(false),
				notify: vi.fn(),
			},
		};
	}

	it("removes a job from a headless tool call without confirmation", async () => {
		const { pi, tools } = createPi();
		registerCron(pi as never);
		saveJobs([makeJob(tmpDir, "daily")]);
		const ctx = makeCtx(false);

		const result = await tools.get("cron").execute("call", { command: "cron remove daily" }, undefined, undefined, ctx);

		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain('Removed cron job "daily"');
		expect(findJob("daily")).toBeUndefined();
	});

	it("removes a job from the slash command without confirmation", async () => {
		const { pi, commands } = createPi();
		registerCron(pi as never);
		saveJobs([makeJob(tmpDir, "daily")]);
		const ctx = makeCtx(true);

		await commands.get("cron").handler("remove daily", ctx);

		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Removed daily", "info");
		expect(findJob("daily")).toBeUndefined();
	});
});
