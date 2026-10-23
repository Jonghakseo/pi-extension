/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const daemonClientMocks = vi.hoisted(() => ({
	getDaemonStatus: vi.fn((): Record<string, unknown> => ({ running: false })),
	scheduleDaemonUpgrade: vi.fn(() => ({ scheduled: false, message: "mock upgrade" })),
	upgradeDaemon: vi.fn(async () => ({ ok: true, message: "mock update" })),
}));

vi.mock("./daemon-client.ts", () => ({
	getDaemonStatus: daemonClientMocks.getDaemonStatus,
	scheduleDaemonUpgrade: daemonClientMocks.scheduleDaemonUpgrade,
	upgradeDaemon: daemonClientMocks.upgradeDaemon,
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
	const eventBus = new Map<string, (value: unknown) => void>();
	return {
		tools,
		commands,
		events,
		pi: {
			on: vi.fn((event: string, handler: any) => events.set(event, handler)),
			registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
			registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
			events: {
				on: vi.fn((channel: string, handler: (value: unknown) => void) => {
					eventBus.set(channel, handler);
					return () => eventBus.delete(channel);
				}),
				emit: vi.fn((channel: string, value: unknown) => eventBus.get(channel)?.(value)),
			},
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
		daemonClientMocks.scheduleDaemonUpgrade.mockClear();
		daemonClientMocks.upgradeDaemon.mockClear();
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

	it("schedules a nonblocking daemon runtime check when a session starts", async () => {
		vi.useFakeTimers();
		const { pi, events } = createPi();
		registerCron(pi as never);

		const starting = events.get("session_start")({ reason: "startup" }, makeCtx(false));
		await vi.advanceTimersByTimeAsync(0);
		await starting;

		expect(daemonClientMocks.scheduleDaemonUpgrade).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it("shows one warning instead of failing when another window owns the session", async () => {
		const previousSuppression = process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE;
		process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE = "1";
		const first = createPi();
		const duplicate = createPi();
		registerCron(first.pi as never);
		registerCron(duplicate.pi as never);
		const ctx = makeCtx(true);

		await first.events.get("session_start")({ reason: "startup" }, ctx);
		try {
			await expect(duplicate.events.get("session_start")({ reason: "startup" }, ctx)).resolves.toBeUndefined();
			await duplicate.events.get("agent_end")({}, ctx);
			expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				"Cron: 이 세션은 다른 Pi 창에서 이미 열려 있어 기존 연결을 사용합니다.",
				"warning",
			);
		} finally {
			await duplicate.events.get("session_shutdown")();
			await first.events.get("session_shutdown")();
			if (previousSuppression === undefined) delete process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE;
			else process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE = previousSuppression;
		}
	});

	it("does not schedule a detached upgrade inside the awaited runtime update RPC", async () => {
		vi.useFakeTimers();
		const previousSuppression = process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE;
		process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE = "1";
		try {
			const { pi, events, commands } = createPi();
			registerCron(pi as never);

			await events.get("session_start")({ reason: "startup" }, makeCtx(false));
			await vi.advanceTimersByTimeAsync(0);
			await commands.get("cron").handler("update-runtime", makeCtx(false));

			expect(daemonClientMocks.scheduleDaemonUpgrade).not.toHaveBeenCalled();
			expect(daemonClientMocks.upgradeDaemon).toHaveBeenCalledTimes(1);
		} finally {
			if (previousSuppression === undefined) delete process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE;
			else process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE = previousSuppression;
			vi.useRealTimers();
		}
	});

	it("propagates a runtime update failure instead of acknowledging it as successful", async () => {
		daemonClientMocks.upgradeDaemon.mockResolvedValueOnce({ ok: false, message: "drain timed out" });
		const { pi, commands } = createPi();
		registerCron(pi as never);

		await expect(commands.get("cron").handler("update-runtime", makeCtx(false))).rejects.toThrow("drain timed out");
	});

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

	describe("guard", () => {
		const guardedUpsert = `cron upsert --name watch --kind cron --schedule "*/10 * * * *" --guard 'echo "PR list"' --guard-mode changed -- "notify"`;

		it.each([
			["a daemon without capabilities", { running: true, pid: 42, runtimeId: "old-runtime" }],
			["a legacy pid-only daemon", { running: true, pid: 42, legacy: true }],
		])("refuses a guarded job while %s is running, before writing anything", async (_label, status) => {
			daemonClientMocks.getDaemonStatus.mockReturnValue(status);
			const { pi, tools } = createPi();
			registerCron(pi as never);

			await expect(
				tools.get("cron").execute("upsert", { command: guardedUpsert }, undefined, undefined, makeCtx(false)),
			).rejects.toThrow("cron update-runtime");
			expect(findJob("watch")).toBeUndefined();
			expect(fs.existsSync(path.join(tmpDir, "cron", "prompts", "watch.md"))).toBe(false);
		});

		it("refuses to add a guard to, or enable, a guarded job on an old daemon", async () => {
			daemonClientMocks.getDaemonStatus.mockReturnValue({ running: true, pid: 42, runtimeId: "old-runtime" });
			const { pi, tools } = createPi();
			registerCron(pi as never);
			saveJobs([
				makeJob(tmpDir, "plain"),
				{ ...makeJob(tmpDir, "paused"), enabled: false, disabledReason: "user_disabled", guard: "exit 1" },
			]);
			const ctx = makeCtx(false);

			await expect(
				tools.get("cron").execute("u", { command: "cron update plain --guard 'exit 0'" }, undefined, undefined, ctx),
			).rejects.toThrow("cron update-runtime");
			expect(findJob("plain")?.guard).toBeUndefined();
			await expect(
				tools.get("cron").execute("e", { command: "cron enable paused" }, undefined, undefined, ctx),
			).rejects.toThrow("cron update-runtime");
			expect(findJob("paused")?.enabled).toBe(false);
			// Disabled guarded jobs cannot run, so they may be edited on any daemon.
			await tools
				.get("cron")
				.execute("u", { command: "cron update paused --guard-timeout 1000" }, undefined, undefined, ctx);
			expect(findJob("paused")?.guardTimeoutMs).toBe(1000);
		});

		it("accepts guards on a guard-capable daemon and removes the guard with its state", async () => {
			daemonClientMocks.getDaemonStatus.mockReturnValue({
				running: true,
				pid: 42,
				runtimeId: "new-runtime",
				capabilities: ["guard"],
			});
			const { pi, tools } = createPi();
			registerCron(pi as never);
			const ctx = makeCtx(false);

			const created = await tools.get("cron").execute("upsert", { command: guardedUpsert }, undefined, undefined, ctx);
			expect(created.details.job).toMatchObject({ guard: 'echo "PR list"', guardMode: "changed" });
			saveJobs([
				{
					...(findJob("watch") as CronJob),
					lastGuardAt: "2026-01-01T00:00:00.000Z",
					lastGuardExit: 0,
					lastGuardHash: "abc",
				},
			]);
			const listed = await tools.get("cron").execute("list", { command: "cron list" }, undefined, undefined, ctx);
			expect(listed.content[0].text).toContain('guard: echo "PR list"');
			expect(listed.content[0].text).toContain("guardMode: changed");
			expect(listed.content[0].text).toContain("lastGuard: 2026-01-01T00:00:00.000Z · exit 0");

			await tools.get("cron").execute("update", { command: 'cron update watch --guard ""' }, undefined, undefined, ctx);
			const removed = findJob("watch") as CronJob;
			for (const field of ["guard", "guardMode", "guardTimeoutMs", "lastGuardAt", "lastGuardExit", "lastGuardHash"]) {
				expect(removed).not.toHaveProperty(field);
			}
		});

		it.each([
			["a daemon without capabilities", { running: true, pid: 42, runtimeId: "old-runtime" }],
			["a legacy pid-only daemon", { running: true, pid: 42, legacy: true }],
		])("warns at the top of cron list when %s would ignore enabled guards", async (_label, status) => {
			daemonClientMocks.getDaemonStatus.mockReturnValue(status);
			const { pi, tools } = createPi();
			registerCron(pi as never);
			saveJobs([{ ...makeJob(tmpDir, "watch"), guard: "exit 0" }]);

			const listed = await tools
				.get("cron")
				.execute("list", { command: "cron list" }, undefined, undefined, makeCtx(false));
			const lines = String(listed.content[0].text).split("\n");
			expect(lines[0]).toContain("cron update-runtime");
			expect(lines[0]).toContain("PID 42");
		});

		it("lists guarded jobs without a warning on a capable or stopped daemon, or when the guard is disabled", async () => {
			const { pi, tools } = createPi();
			registerCron(pi as never);
			const ctx = makeCtx(false);
			saveJobs([{ ...makeJob(tmpDir, "watch"), guard: "exit 0" }]);

			for (const status of [
				{ running: true, pid: 42, runtimeId: "new", capabilities: ["guard"] },
				{ running: false },
			]) {
				daemonClientMocks.getDaemonStatus.mockReturnValue(status);
				const listed = await tools.get("cron").execute("list", { command: "cron list" }, undefined, undefined, ctx);
				expect(listed.content[0].text).not.toContain("update-runtime");
			}

			saveJobs([{ ...makeJob(tmpDir, "watch"), guard: "exit 0", enabled: false, disabledReason: "user_disabled" }]);
			daemonClientMocks.getDaemonStatus.mockReturnValue({ running: true, pid: 42, runtimeId: "old" });
			const listed = await tools.get("cron").execute("list", { command: "cron list" }, undefined, undefined, ctx);
			expect(listed.content[0].text).not.toContain("update-runtime");
		});

		it("counts enabled guarded jobs with a recorded guard error in cron status", async () => {
			daemonClientMocks.getDaemonStatus.mockReturnValue({
				running: true,
				pid: 42,
				runtimeId: "new",
				capabilities: ["guard"],
			});
			const { pi, tools } = createPi();
			registerCron(pi as never);
			const ctx = makeCtx(false);
			saveJobs([
				{ ...makeJob(tmpDir, "broken"), guard: "exit 2", lastGuardExit: 2, lastGuardError: "guard exited with code 2" },
				{ ...makeJob(tmpDir, "broken-too"), guard: "exit 2", lastGuardError: "guard timed out after 1000ms" },
				{ ...makeJob(tmpDir, "fine"), guard: "exit 0", lastGuardExit: 0 },
				{ ...makeJob(tmpDir, "plain"), lastGuardError: "stale" },
			]);

			const status = await tools.get("cron").execute("s", { command: "cron status" }, undefined, undefined, ctx);
			expect(status.content[0].text).toContain("Guard errors: 2 job(s) (see cron list)");

			saveJobs([{ ...makeJob(tmpDir, "fine"), guard: "exit 0", lastGuardExit: 0 }]);
			const clean = await tools.get("cron").execute("s", { command: "cron status" }, undefined, undefined, ctx);
			expect(clean.content[0].text).not.toContain("Guard errors");
		});

		it("allows a guarded job with a warning when the daemon is stopped", async () => {
			daemonClientMocks.getDaemonStatus.mockReturnValue({ running: false });
			const { pi, tools } = createPi();
			registerCron(pi as never);

			const result = await tools
				.get("cron")
				.execute("upsert", { command: guardedUpsert }, undefined, undefined, makeCtx(false));
			expect(findJob("watch")?.guard).toBe('echo "PR list"');
			expect(result.content[0].text).toContain("cron daemon is not running");
		});
	});

	describe("session start attention banner", () => {
		async function startSession(ctx: ReturnType<typeof makeCtx>, reason = "startup") {
			const { pi, events } = createPi();
			registerCron(pi as never);
			try {
				await events.get("session_start")({ reason }, ctx);
			} finally {
				await events.get("session_shutdown")();
			}
		}

		function bannerText(ctx: ReturnType<typeof makeCtx>): string | undefined {
			const call = ctx.ui.notify.mock.calls.find((args: unknown[]) =>
				String(args[0]).startsWith("Cron: 확인이 필요한"),
			);
			return call?.[0] as string | undefined;
		}

		const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
		let previousSuppression: string | undefined;

		beforeEach(() => {
			previousSuppression = process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE;
			process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE = "1";
		});

		afterEach(() => {
			if (previousSuppression === undefined) delete process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE;
			else process.env.PI_CRON_SUPPRESS_AUTO_UPGRADE = previousSuppression;
		});

		it("lists repeated guard errors, run and delivery failures, and recent failed one-shots", async () => {
			const sessionFile = path.join(tmpDir, "session-a.jsonl");
			saveStore({
				version: 2,
				jobs: [
					{
						...makeJob(tmpDir, "pr-watch"),
						guard: "python3 check.py",
						guardErrorStreak: 13,
						guardErrorSince: hoursAgo(2),
						lastGuardExit: 127,
						lastGuardError: "guard exited with code 127: python3: command not found",
					},
					{ ...makeJob(tmpDir, "flaky-guard"), guard: "check", guardErrorStreak: 2, lastGuardError: "boom" },
					{ ...makeJob(tmpDir, "nightly"), lastRunAt: hoursAgo(1), lastExitCode: 124 },
					{
						...makeJob(tmpDir, "follow-up"),
						scope: "session",
						sessionId: "session-a",
						sessionFile,
						lastDeliveryOutcome: "failed",
						lastDeliveryError: "connect ECONNREFUSED",
					},
					{ ...makeJob(tmpDir, "paused"), enabled: false, disabledReason: "user_disabled", lastExitCode: 1 },
					{ ...makeJob(tmpDir, "healthy"), lastExitCode: 0 },
				],
				history: [
					{ ...makeJob(tmpDir, "reminder"), enabled: false, completedAt: hoursAgo(3), lastExitCode: 1 },
					{ ...makeJob(tmpDir, "old-reminder"), enabled: false, completedAt: hoursAgo(30), lastExitCode: 1 },
				],
			});
			const ctx = makeCtx(true);

			await startSession(ctx);

			const banner = bannerText(ctx) as string;
			expect(ctx.ui.notify).toHaveBeenCalledWith(banner, "warning");
			expect(banner).toContain("Cron: 확인이 필요한 작업 4건");
			expect(banner).toContain("pr-watch: 2시간째 guard 실패 (13회 연속 · exit 127)");
			expect(banner).toContain("python3: command not found");
			expect(banner).toContain("nightly:");
			expect(banner).toContain("실행 실패 (exit 124)");
			expect(banner).toContain("follow-up:");
			expect(banner).toContain("세션 전달 실패: connect ECONNREFUSED");
			expect(banner).toContain("reminder (한 번 실행)");
			for (const quiet of ["flaky-guard", "paused", "healthy", "old-reminder"]) expect(banner).not.toContain(quiet);
		});

		it("warns that guarded jobs run unguarded while an old daemon is running", async () => {
			daemonClientMocks.getDaemonStatus.mockReturnValue({ running: true, pid: 809, runtimeId: "old-runtime" });
			saveJobs([{ ...makeJob(tmpDir, "pr-watch"), guard: "check" }]);
			const ctx = makeCtx(true);

			await startSession(ctx);

			expect(bannerText(ctx)).toContain("PID 809");
			expect(bannerText(ctx)).toContain("cron update-runtime");
		});

		it("stays silent when nothing needs attention, on reload, and without a UI", async () => {
			saveJobs([{ ...makeJob(tmpDir, "nightly"), lastExitCode: 0 }]);
			const healthy = makeCtx(true);
			await startSession(healthy);
			expect(bannerText(healthy)).toBeUndefined();

			saveJobs([{ ...makeJob(tmpDir, "nightly"), lastExitCode: 1 }]);
			const reloaded = makeCtx(true);
			await startSession(reloaded, "reload");
			expect(bannerText(reloaded)).toBeUndefined();
			const headless = makeCtx(false);
			await startSession(headless);
			expect(bannerText(headless)).toBeUndefined();
			const fresh = makeCtx(true);
			await startSession(fresh);
			expect(bannerText(fresh)).toContain("nightly:");
		});
	});
});
