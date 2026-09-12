/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./daemon-client.ts", () => ({
	getDaemonStatus: () => ({ running: false }),
	startDaemon: () => ({ message: "mock daemon" }),
	stopDaemon: () => ({ message: "mock daemon" }),
}));
vi.mock("./launchd.ts", () => ({
	getLaunchdStatus: () => ({ installed: true, loaded: true, plistPath: "/tmp/mock.plist", label: "mock" }),
	installLaunchAgent: () => ({ message: "mock launchd" }),
	uninstallLaunchAgent: () => ({ message: "mock launchd" }),
}));

import registerCron from "./index.ts";
import { resolveProjectId } from "./project-id.ts";
import { findJob, saveJobs, saveStore } from "./store.ts";
import type { CronJob } from "./types.ts";

function createPi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	return {
		tools,
		commands,
		events,
		pi: {
			on: vi.fn((event: string, handler: any) => events.set(event, handler)),
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

	function makeCtx(hasUI: boolean, sessionId = "session-a") {
		const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
		fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`);
		return {
			cwd: tmpDir,
			hasUI,
			sessionManager: {
				getSessionId: () => sessionId,
				getSessionFile: () => sessionFile,
			},
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
		expect(ctx.ui.notify).toHaveBeenCalledWith('✓ Removed cron job "daily".', "info");
		expect(findJob("daily")).toBeUndefined();
	});

	it("preserves a running claim while updating its next schedule", async () => {
		const { pi, tools } = createPi();
		registerCron(pi as never);
		const running = {
			...makeJob(tmpDir, "executing"),
			running: true,
			runToken: "claimed-token",
			runPromptFile: path.join(tmpDir, "cron", "runs", "executing", "claimed.prompt.md"),
		};
		saveJobs([running]);
		const result = await tools
			.get("cron")
			.execute(
				"update",
				{ command: 'cron update executing --schedule "30 10 * * *"' },
				undefined,
				undefined,
				makeCtx(false),
			);

		expect(result.details.job).toMatchObject({
			id: "executing",
			running: true,
			runToken: "claimed-token",
			runPromptFile: running.runPromptFile,
			schedule: "30 10 * * *",
		});
	});

	it("filters lists and mutation access by user, current project, and current session", async () => {
		const { pi, tools } = createPi();
		registerCron(pi as never);
		const projectId = resolveProjectId(tmpDir).id;
		const sessionFile = path.join(tmpDir, "session-a.jsonl");
		saveJobs([
			{ ...makeJob(tmpDir, "user"), scope: "user" },
			{ ...makeJob(tmpDir, "project"), scope: "project", projectId },
			{ ...makeJob(tmpDir, "session"), scope: "session", sessionId: "session-a", sessionFile },
			{ ...makeJob(tmpDir, "foreign-project"), scope: "project", projectId: "other" },
			{
				...makeJob(tmpDir, "foreign-session"),
				scope: "session",
				sessionId: "other",
				sessionFile: path.join(tmpDir, "other.jsonl"),
			},
		]);
		const ctx = makeCtx(false);

		const listed = await tools.get("cron").execute("list", { command: "cron list" }, undefined, undefined, ctx);
		expect(listed.details.jobs.map((job: CronJob) => job.id)).toEqual(["project", "session", "user"]);
		const removed = await tools
			.get("cron")
			.execute("remove", { command: "cron remove foreign-project --scope project" }, undefined, undefined, ctx);
		expect(removed.content[0].text).toContain("not found");
		expect(findJob("foreign-project")).toBeDefined();
		const scoped = await tools
			.get("cron")
			.execute("session", { command: "cron list --scope session" }, undefined, undefined, ctx);
		expect(scoped.details.jobs.map((job: CronJob) => job.id)).toEqual(["session"]);
	});

	it("rejects normalized foreign IDs and missing session scope before writing prompts", async () => {
		const { pi, tools } = createPi();
		registerCron(pi as never);
		const foreign = {
			...makeJob(tmpDir, "foreign-session"),
			scope: "session" as const,
			sessionId: "other",
			sessionFile: path.join(tmpDir, "other.jsonl"),
		};
		fs.mkdirSync(path.dirname(foreign.promptFile), { recursive: true });
		fs.writeFileSync(foreign.promptFile, "original foreign prompt\n");
		saveJobs([foreign]);
		const ctx = makeCtx(false);

		await expect(
			tools
				.get("cron")
				.execute(
					"upsert",
					{ command: 'cron upsert FOREIGN-SESSION --name overwrite --kind cron --schedule "0 10 * * *" -- "bad"' },
					undefined,
					undefined,
					ctx,
				),
		).rejects.toThrow("current accessible scope");
		expect(fs.readFileSync(foreign.promptFile, "utf8")).toBe("original foreign prompt\n");

		const noSessionCtx = {
			...ctx,
			sessionManager: { getSessionId: () => undefined, getSessionFile: () => undefined },
		};
		await expect(
			tools.get("cron").execute(
				"upsert",
				{
					command:
						'cron upsert session-new --name session-new --kind cron --schedule "0 10 * * *" --scope session -- "bad"',
				},
				undefined,
				undefined,
				noSessionCtx,
			),
		).rejects.toThrow("persisted current Pi session");
		expect(fs.existsSync(path.join(tmpDir, "cron", "prompts", "session-new.md"))).toBe(false);
	});

	it("keeps project ownership at the invoking project when --cwd chooses another execution directory", async () => {
		const { pi, tools } = createPi();
		registerCron(pi as never);
		const ownerProject = path.join(tmpDir, "owner-project");
		const executionDirectory = path.join(tmpDir, "execution-directory");
		fs.mkdirSync(ownerProject, { recursive: true });
		fs.mkdirSync(executionDirectory, { recursive: true });
		const sessionFile = path.join(tmpDir, "session-a.jsonl");
		fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session-a" })}\n`);
		const makeProjectCtx = (cwd: string) => ({
			cwd,
			hasUI: false,
			sessionManager: { getSessionId: () => "session-a", getSessionFile: () => sessionFile },
			ui: { confirm: vi.fn(), notify: vi.fn() },
		});
		const ownerCtx = makeProjectCtx(ownerProject);
		const otherCtx = makeProjectCtx(executionDirectory);

		const created = await tools.get("cron").execute(
			"create",
			{
				command: `cron upsert project-job --name project-job --kind cron --schedule "0 10 * * *" --scope project --cwd ${executionDirectory} -- prompt`,
			},
			undefined,
			undefined,
			ownerCtx,
		);
		const ownerJobs = await tools
			.get("cron")
			.execute("owner-list", { command: "cron list --scope project" }, undefined, undefined, ownerCtx);
		const otherJobs = await tools
			.get("cron")
			.execute("other-list", { command: "cron list --scope project" }, undefined, undefined, otherCtx);

		expect(created.details.job).toMatchObject({
			projectId: resolveProjectId(ownerProject).id,
			cwd: executionDirectory,
		});
		expect(ownerJobs.details.jobs.map((job: CronJob) => job.id)).toEqual(["project-job"]);
		expect(otherJobs.details.jobs).toEqual([]);
	});

	it("separates current jobs from completed one-shot history", async () => {
		const { pi, tools, commands } = createPi();
		registerCron(pi as never);
		const current = makeJob(tmpDir, "daily");
		const historical: CronJob = {
			...makeJob(tmpDir, "reminder"),
			enabled: false,
			once: true,
			disabledReason: "completed_once",
			completedAt: "2026-01-02T00:00:00.000Z",
			lastExitCode: 0,
		};
		fs.mkdirSync(path.dirname(historical.promptFile), { recursive: true });
		const runPromptFile = path.join(tmpDir, "cron", "runs", "reminder", "claimed.prompt.md");
		fs.mkdirSync(path.dirname(runPromptFile), { recursive: true });
		fs.writeFileSync(historical.promptFile, "# Updated source prompt\n");
		fs.writeFileSync(runPromptFile, "# Preserved reminder prompt\n");
		historical.lastRunPromptFile = runPromptFile;
		saveStore({ version: 2, jobs: [current], history: [historical] });
		const ctx = makeCtx(true);

		const listed = await tools.get("cron").execute("list", { command: "cron list" }, undefined, undefined, ctx);
		const history = await tools
			.get("cron")
			.execute("history", { command: "cron history --include-prompt" }, undefined, undefined, ctx);
		await commands.get("cron").handler("history", ctx);

		expect(listed.content[0].text).toContain("daily");
		expect(listed.content[0].text).not.toContain("reminder");
		expect(history.content[0].text).toContain("reminder");
		expect(history.content[0].text).toContain("Preserved reminder prompt");
		expect(history.content[0].text).not.toContain("daily");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reminder"), "info");
	});
});
