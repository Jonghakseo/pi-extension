import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withStoreLock, writeAtomicFile } from "./store-lock.mjs";
import type { CronJob, CronStoreFile } from "./types.ts";

const STORE_VERSION = 2 as const;

interface LegacyCronStoreFile {
	version: 1;
	jobs: CronJob[];
}

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

export function getSessionRegistryDir(): string {
	return join(getCronDir(), "sessions");
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
	mkdirSync(getSessionRegistryDir(), { recursive: true });
}

export function emptyStore(): CronStoreFile {
	return { version: STORE_VERSION, jobs: [], history: [] };
}

function isCompletedOneShot(job: CronJob): boolean {
	return job.disabledReason === "completed_once";
}

function loadStoreUnsafe(): CronStoreFile {
	const jobsPath = getJobsPath();
	if (!existsSync(jobsPath)) return emptyStore();

	try {
		const parsed = JSON.parse(readFileSync(jobsPath, "utf-8")) as Partial<CronStoreFile> | Partial<LegacyCronStoreFile>;
		if (!Array.isArray(parsed.jobs)) return emptyStore();
		if (parsed.version === 1) {
			return {
				version: STORE_VERSION,
				jobs: parsed.jobs.filter((job) => !isCompletedOneShot(job)),
				history: parsed.jobs.filter(isCompletedOneShot),
			};
		}
		if (parsed.version !== STORE_VERSION || !("history" in parsed) || !Array.isArray(parsed.history)) {
			return emptyStore();
		}
		return { version: STORE_VERSION, jobs: parsed.jobs, history: parsed.history };
	} catch {
		return emptyStore();
	}
}

function historyTimestamp(job: CronJob): string {
	return job.completedAt ?? job.lastRunAt ?? job.updatedAt;
}

function saveStoreUnsafe(store: CronStoreFile): void {
	const jobs = [...store.jobs].sort((a, b) => a.id.localeCompare(b.id));
	const history = [...store.history].sort(
		(a, b) => historyTimestamp(b).localeCompare(historyTimestamp(a)) || a.id.localeCompare(b.id),
	);
	writeAtomicFile(getJobsPath(), `${JSON.stringify({ version: STORE_VERSION, jobs, history }, null, 2)}\n`);
}

export function loadStore(): CronStoreFile {
	ensureCronDirs();
	return loadStoreUnsafe();
}

/** Runs a complete store read-modify-write while holding the shared daemon lock. */
export function withStoreTransaction<T>(update: (store: CronStoreFile) => T): T {
	ensureCronDirs();
	return withStoreLock(getCronDir(), () => {
		const store = loadStoreUnsafe();
		const result = update(store);
		saveStoreUnsafe(store);
		return result;
	});
}

export function saveStore(store: CronStoreFile): void {
	ensureCronDirs();
	withStoreLock(getCronDir(), () => saveStoreUnsafe(store));
}

export function loadJobs(): CronJob[] {
	return loadStore().jobs;
}

export function loadHistory(): CronJob[] {
	return loadStore().history;
}

export function saveJobs(jobs: CronJob[]): void {
	withStoreTransaction((store) => {
		store.jobs = jobs;
	});
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

export function allocateJobIdFromStore(store: CronStoreFile, name: string, requestedId?: string): string {
	const base = slugifyJobId(requestedId || name);
	assertValidJobId(base);

	const activeIds = new Set(store.jobs.map((job) => job.id));
	const historicalIds = new Set(store.history.map((job) => job.id));
	const reservedIds = new Set([...activeIds, ...historicalIds]);
	if (!reservedIds.has(base)) return base;
	if (requestedId) {
		if (historicalIds.has(base) && !activeIds.has(base)) {
			throw new Error(`Cron job id "${base}" is reserved by history. Choose another id.`);
		}
		return base;
	}

	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		if (!reservedIds.has(candidate)) return candidate;
	}

	throw new Error(`Could not allocate unique cron job id for "${name}"`);
}

export function allocateJobId(name: string, requestedId?: string): string {
	return withStoreTransaction((store) => allocateJobIdFromStore(store, name, requestedId));
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
	writeAtomicFile(promptPath, `${markdown.trimEnd()}\n`);
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
	return withStoreTransaction((store) => {
		const index = store.jobs.findIndex((item) => item.id === job.id);
		if (index === -1) store.jobs.push(job);
		else store.jobs[index] = job;
		return job;
	});
}

export function updateJob(id: string, update: (job: CronJob) => CronJob): CronJob | undefined {
	return withStoreTransaction((store) => {
		const index = store.jobs.findIndex((job) => job.id === id);
		if (index === -1) return undefined;
		const next = update(store.jobs[index]);
		store.jobs[index] = { ...next, updatedAt: new Date().toISOString() };
		return store.jobs[index];
	});
}

export function removeJob(id: string): boolean {
	return withStoreTransaction((store) => {
		const index = store.jobs.findIndex((job) => job.id === id);
		if (index === -1) return false;
		store.jobs.splice(index, 1);
		return true;
	});
}
