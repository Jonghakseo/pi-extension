import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CronJob, CronStoreFile } from "./types.ts";

const STORE_VERSION = 1 as const;

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getCronDir(): string {
	return join(getAgentDir(), "cron");
}

export function getJobsPath(): string {
	return join(getCronDir(), "jobs.json");
}

export function getPromptsDir(): string {
	return join(getCronDir(), "prompts");
}

export function getRunsDir(): string {
	return join(getCronDir(), "runs");
}

export function getDaemonPidPath(): string {
	return join(getCronDir(), "daemon.pid");
}

export function getDaemonLogPath(): string {
	return join(getCronDir(), "daemon.log");
}

export function getDaemonErrorLogPath(): string {
	return join(getCronDir(), "daemon.err.log");
}

export function ensureCronDirs(): void {
	mkdirSync(getCronDir(), { recursive: true });
	mkdirSync(getPromptsDir(), { recursive: true });
	mkdirSync(getRunsDir(), { recursive: true });
}

export function emptyStore(): CronStoreFile {
	return { version: STORE_VERSION, jobs: [] };
}

export function loadStore(): CronStoreFile {
	ensureCronDirs();
	const jobsPath = getJobsPath();
	if (!existsSync(jobsPath)) return emptyStore();

	try {
		const parsed = JSON.parse(readFileSync(jobsPath, "utf-8")) as Partial<CronStoreFile>;
		if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.jobs)) return emptyStore();
		return { version: STORE_VERSION, jobs: parsed.jobs };
	} catch {
		return emptyStore();
	}
}

export function saveStore(store: CronStoreFile): void {
	ensureCronDirs();
	const jobsPath = getJobsPath();
	const tmpPath = `${jobsPath}.tmp`;
	const sorted = [...store.jobs].sort((a, b) => a.id.localeCompare(b.id));
	writeFileSync(tmpPath, `${JSON.stringify({ version: STORE_VERSION, jobs: sorted }, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, jobsPath);
}

export function loadJobs(): CronJob[] {
	return loadStore().jobs;
}

export function saveJobs(jobs: CronJob[]): void {
	saveStore({ version: STORE_VERSION, jobs });
}

export function slugifyJobId(input: string): string {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "cron-job";
}

export function assertValidJobId(id: string): void {
	if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
		throw new Error(`Invalid cron job id "${id}". Allowed characters: a-z A-Z 0-9 . _ -`);
	}
}

export function allocateJobId(name: string, requestedId?: string): string {
	const base = slugifyJobId(requestedId || name);
	assertValidJobId(base);

	const existing = new Set(loadJobs().map((job) => job.id));
	if (!existing.has(base)) return base;
	if (requestedId) return base;

	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		if (!existing.has(candidate)) return candidate;
	}

	throw new Error(`Could not allocate unique cron job id for "${name}"`);
}

export function getPromptPath(id: string): string {
	assertValidJobId(id);
	ensureCronDirs();
	const promptsDir = realpathSync(getPromptsDir());
	const promptPath = resolve(promptsDir, `${id}.md`);
	if (!promptPath.startsWith(`${promptsDir}/`) && promptPath !== promptsDir) {
		throw new Error(`Prompt path escaped prompts directory: ${promptPath}`);
	}
	return promptPath;
}

export function writePromptFile(id: string, markdown: string): string {
	const promptPath = getPromptPath(id);
	mkdirSync(dirname(promptPath), { recursive: true });
	writeFileSync(promptPath, `${markdown.trimEnd()}\n`, "utf-8");
	return promptPath;
}

export function readPromptFile(id: string): string | undefined {
	try {
		return readFileSync(getPromptPath(id), "utf-8");
	} catch {
		return undefined;
	}
}

export function findJob(id: string): CronJob | undefined {
	return loadJobs().find((job) => job.id === id);
}

export function upsertJob(job: CronJob): CronJob {
	assertValidJobId(job.id);
	const jobs = loadJobs();
	const index = jobs.findIndex((item) => item.id === job.id);
	if (index === -1) {
		jobs.push(job);
	} else {
		jobs[index] = job;
	}
	saveJobs(jobs);
	return job;
}

export function updateJob(id: string, update: (job: CronJob) => CronJob): CronJob | undefined {
	const jobs = loadJobs();
	const index = jobs.findIndex((job) => job.id === id);
	if (index === -1) return undefined;
	const next = update(jobs[index]);
	jobs[index] = { ...next, updatedAt: new Date().toISOString() };
	saveJobs(jobs);
	return jobs[index];
}

export function removeJob(id: string): boolean {
	const jobs = loadJobs();
	const next = jobs.filter((job) => job.id !== id);
	if (next.length === jobs.length) return false;
	saveJobs(next);
	return true;
}
