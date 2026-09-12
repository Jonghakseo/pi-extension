import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	allocateJobId,
	assertValidJobId,
	findJob,
	getCronDir,
	getJobsPath,
	getPromptPath,
	loadHistory,
	loadJobs,
	readPromptFile,
	removeJob,
	saveJobs,
	saveStore,
	slugifyJobId,
	updateJob,
	upsertJob,
	writePromptFile,
} from "./store.js";
import type { CronJob } from "./types.js";

let tempAgentDir: string;
let previousAgentDir: string | undefined;

function makeJob(id: string): CronJob {
	return {
		id,
		name: id,
		enabled: true,
		kind: "cron",
		once: false,
		schedule: "0 10 * * *",
		timezone: "UTC",
		cwd: tempAgentDir,
		promptFile: join(tempAgentDir, "cron", "prompts", `${id}.md`),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T10:00:00.000Z",
	};
}

describe("cron store", () => {
	beforeEach(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempAgentDir = join(tmpdir(), `pi-cron-store-test-${process.pid}-${Date.now()}-${Math.random()}`);
		process.env.PI_CODING_AGENT_DIR = tempAgentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) process.env.PI_CODING_AGENT_DIR = undefined;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(tempAgentDir, { recursive: true, force: true });
	});

	it("uses PI_CODING_AGENT_DIR for cron storage", () => {
		expect(getCronDir()).toBe(join(tempAgentDir, "cron"));
		expect(getJobsPath()).toBe(join(tempAgentDir, "cron", "jobs.json"));
	});

	it("loads empty current and history lists when jobs.json does not exist", () => {
		expect(loadJobs()).toEqual([]);
		expect(loadHistory()).toEqual([]);
	});

	it("saves, loads, finds, updates, and removes jobs", () => {
		const job = makeJob("daily-check");
		upsertJob(job);

		expect(existsSync(getJobsPath())).toBe(true);
		expect(loadJobs()).toHaveLength(1);
		expect(findJob("daily-check")?.name).toBe("daily-check");

		const updated = updateJob("daily-check", (current) => ({
			...current,
			enabled: false,
			disabledReason: "user_disabled",
		}));
		expect(updated?.enabled).toBe(false);
		expect(findJob("daily-check")?.disabledReason).toBe("user_disabled");

		expect(removeJob("daily-check")).toBe(true);
		expect(removeJob("daily-check")).toBe(false);
		expect(loadJobs()).toEqual([]);
	});

	it("preserves every job from concurrent extension-process upserts", async () => {
		mkdirSync(tempAgentDir, { recursive: true });
		const workerPath = join(tempAgentDir, "concurrent-upsert.mjs");
		const gatePath = join(tempAgentDir, "start-gate");
		writeFileSync(
			workerPath,
			`import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upsertJob } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
const [id, gate, ready] = process.argv.slice(2);
writeFileSync(ready, "ready");
const deadline = Date.now() + 5000;
while (!existsSync(gate)) {
  if (Date.now() >= deadline) throw new Error("timed out waiting for concurrent writer gate");
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const now = new Date().toISOString();
upsertJob({ id, name: id, enabled: true, kind: "cron", once: false, schedule: "0 10 * * *", timezone: "UTC", cwd: process.env.PI_CODING_AGENT_DIR, promptFile: join(process.env.PI_CODING_AGENT_DIR, "cron", "prompts", id + ".md"), createdAt: now, updatedAt: now });
`,
		);
		const writers = Array.from({ length: 24 }, (_, index) => {
			const id = `writer-${index}`;
			const readyPath = join(tempAgentDir, `${id}.ready`);
			return new Promise<void>((resolveWriter, rejectWriter) => {
				const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, id, gatePath, readyPath], {
					env: process.env,
					stdio: "pipe",
				});
				let stderr = "";
				child.stderr.on("data", (chunk) => (stderr += chunk));
				child.on("error", rejectWriter);
				child.on("close", (code) => {
					if (code === 0) resolveWriter();
					else rejectWriter(new Error(`writer ${id} exited ${code}: ${stderr}`));
				});
			});
		});
		const readyDeadline = Date.now() + 5000;
		while (
			Array.from({ length: 24 }, (_, index) => existsSync(join(tempAgentDir, `writer-${index}.ready`))).some(
				(ready) => !ready,
			)
		) {
			if (Date.now() >= readyDeadline) throw new Error("timed out waiting for concurrent writers");
			await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		}
		writeFileSync(gatePath, "go");
		await Promise.all(writers);

		expect(loadJobs().map((job) => job.id)).toEqual(
			Array.from({ length: 24 }, (_, index) => `writer-${index}`).sort((a, b) => a.localeCompare(b)),
		);
	});

	it("reclaims a store lock held by a provably dead writer", () => {
		const lockDir = join(getCronDir(), "jobs.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({ pid: 999_999, token: "dead" })}\n`);

		upsertJob(makeJob("reclaimed"));

		expect(loadJobs().map((job) => job.id)).toEqual(["reclaimed"]);
	});

	it("reclaims a lock whose PID was reused by a different process instance", () => {
		mkdirSync(getCronDir(), { recursive: true });
		writeFileSync(
			join(getCronDir(), "jobs.lock"),
			JSON.stringify({ pid: process.pid, processIdentity: "previous-process-instance", token: "stale-lock" }),
		);

		upsertJob(makeJob("reclaimed-recycled-pid"));
		expect(loadJobs().map((job) => job.id)).toEqual(["reclaimed-recycled-pid"]);
	});

	it("recovers a dead reclaimer while clearing a dead store owner", () => {
		const lockPath = join(getCronDir(), "jobs.lock");
		mkdirSync(getCronDir(), { recursive: true });
		writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999, token: "dead-owner" })}\n`);
		writeFileSync(`${lockPath}.reclaim`, `${JSON.stringify({ pid: 999_998, token: "dead-reclaimer" })}\n`);

		upsertJob(makeJob("reclaimed-after-reclaimer-crash"));
		expect(loadJobs().map((job) => job.id)).toEqual(["reclaimed-after-reclaimer-crash"]);
	});

	it("does not publish a blocking lock when a writer dies after recording ownership", () => {
		mkdirSync(tempAgentDir, { recursive: true });
		const writerPath = join(tempAgentDir, "crash-after-lock-record.mjs");
		writeFileSync(
			writerPath,
			`import { upsertJob } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
upsertJob({ id: "never-written", name: "never-written", enabled: true, kind: "cron", once: false, schedule: "0 10 * * *", timezone: "UTC", cwd: process.env.PI_CODING_AGENT_DIR, promptFile: "unused", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
`,
		);
		const crashed = spawnSync(process.execPath, ["--experimental-strip-types", writerPath], {
			env: { ...process.env, PI_CODING_AGENT_DIR: tempAgentDir, PI_CRON_TEST_CRASH_AFTER_LOCK_RECORD: "1" },
			encoding: "utf8",
		});
		expect(crashed.signal).toBe("SIGKILL");
		expect(existsSync(join(getCronDir(), "jobs.lock"))).toBe(false);

		upsertJob(makeJob("after-crash"));
		expect(loadJobs().map((job) => job.id)).toEqual(["after-crash"]);
	});

	it("sorts jobs by id when saving", () => {
		saveJobs([makeJob("z-job"), makeJob("a-job")]);
		const raw = JSON.parse(readFileSync(getJobsPath(), "utf-8"));
		expect(raw.version).toBe(2);
		expect(raw.jobs.map((job: CronJob) => job.id)).toEqual(["a-job", "z-job"]);
		expect(raw.history).toEqual([]);
	});

	it("migrates completed one-shot jobs from the v1 active list into history", () => {
		const active = makeJob("active");
		const completed = {
			...makeJob("completed"),
			enabled: false,
			once: true,
			disabledReason: "completed_once" as const,
			completedAt: "2026-01-02T00:00:00.000Z",
		};
		mkdirSync(getCronDir(), { recursive: true });
		writeFileSync(getJobsPath(), `${JSON.stringify({ version: 1, jobs: [active, completed] }, null, 2)}\n`);

		expect(loadJobs().map((job) => job.id)).toEqual(["active"]);
		expect(loadHistory().map((job) => job.id)).toEqual(["completed"]);
	});

	it("slugifies and validates job ids", () => {
		expect(slugifyJobId("Daily 릴리즈 Check!!")).toBe("daily-check");
		expect(() => assertValidJobId("ok.ID-_1")).not.toThrow();
		expect(() => assertValidJobId("bad/id")).toThrow("Invalid cron job id");
	});

	it("allocates unique ids when a generated id already exists", () => {
		upsertJob(makeJob("daily-check"));
		expect(allocateJobId("daily check")).toBe("daily-check-2");
		expect(allocateJobId("daily check", "daily-check")).toBe("daily-check");
	});

	it("reserves historical ids so preserved prompts cannot be overwritten", () => {
		const historical = {
			...makeJob("daily-check"),
			enabled: false,
			disabledReason: "completed_once" as const,
			completedAt: "2026-01-02T00:00:00.000Z",
		};
		saveStore({ version: 2, jobs: [], history: [historical] });

		expect(allocateJobId("daily check")).toBe("daily-check-2");
		expect(() => allocateJobId("daily check", "daily-check")).toThrow("reserved by history");
	});

	it("writes prompt files under the prompts directory", () => {
		const promptPath = writePromptFile("daily-check", "# Hello\n");
		expect(promptPath).toBe(getPromptPath("daily-check"));
		expect(readPromptFile("daily-check")).toBe("# Hello\n");
	});

	it("creates parent directories for prompt files", () => {
		const promptPath = getPromptPath("new-job");
		rmSync(tempAgentDir, { recursive: true, force: true });
		mkdirSync(tempAgentDir, { recursive: true });
		writePromptFile("new-job", "body");
		expect(existsSync(promptPath)).toBe(true);
	});
});
