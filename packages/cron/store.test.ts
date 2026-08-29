import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
	loadJobs,
	readPromptFile,
	removeJob,
	saveJobs,
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

	it("loads an empty job list when jobs.json does not exist", () => {
		expect(loadJobs()).toEqual([]);
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

	it("sorts jobs by id when saving", () => {
		saveJobs([makeJob("z-job"), makeJob("a-job")]);
		const raw = JSON.parse(readFileSync(getJobsPath(), "utf-8"));
		expect(raw.jobs.map((job: CronJob) => job.id)).toEqual(["a-job", "z-job"]);
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
