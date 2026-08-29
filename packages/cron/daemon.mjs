#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TICK_INTERVAL_MS = Number.parseInt(process.env.PI_CRON_TICK_INTERVAL_MS || "30000", 10);
const RETRY_LOCK_INTERVAL_MS = Number.parseInt(process.env.PI_CRON_RETRY_LOCK_INTERVAL_MS || "60000", 10);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PI_CRON_JOB_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const STORE_VERSION = 1;

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const cronDir = join(agentDir, "cron");
const jobsPath = join(cronDir, "jobs.json");
const pidPath = join(cronDir, "daemon.pid");
const daemonLogPath = join(cronDir, "daemon.log");
const runsDir = join(cronDir, "runs");

const running = new Set();
let lockHeld = false;
let tickTimer;
let retryTimer;
let ticking = false;

function nowIso() {
	return new Date().toISOString();
}

function ensureDirs() {
	mkdirSync(cronDir, { recursive: true });
	mkdirSync(runsDir, { recursive: true });
}

function log(message, details = undefined) {
	ensureDirs();
	const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
	writeFileSync(daemonLogPath, `[${nowIso()}] ${message}${suffix}\n`, { flag: "a" });
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPid() {
	try {
		const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
		return Number.isInteger(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function tryAcquireLock() {
	ensureDirs();
	const existing = readPid();
	if (existing && existing !== process.pid && isProcessAlive(existing)) {
		return false;
	}
	if (existing) {
		try {
			unlinkSync(pidPath);
		} catch {}
	}
	try {
		writeFileSync(pidPath, String(process.pid), { flag: "wx" });
		lockHeld = true;
		return true;
	} catch (error) {
		if (error?.code === "EEXIST") return false;
		throw error;
	}
}

function releaseLock() {
	if (!lockHeld) return;
	try {
		const pid = readPid();
		if (pid === process.pid) unlinkSync(pidPath);
	} catch {}
	lockHeld = false;
}

function loadJobs() {
	ensureDirs();
	if (!existsSync(jobsPath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(jobsPath, "utf-8"));
		if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.jobs)) return [];
		return parsed.jobs;
	} catch (error) {
		log("failed to load jobs", { error: String(error) });
		return [];
	}
}

function saveJobs(jobs) {
	ensureDirs();
	const tmpPath = `${jobsPath}.tmp`;
	const sorted = [...jobs].sort((a, b) => a.id.localeCompare(b.id));
	writeFileSync(tmpPath, `${JSON.stringify({ version: STORE_VERSION, jobs: sorted }, null, 2)}\n`, "utf-8");
	renameSync(tmpPath, jobsPath);
}

function updateJob(id, updater) {
	const jobs = loadJobs();
	const index = jobs.findIndex((job) => job.id === id);
	if (index === -1) return;
	jobs[index] = { ...updater(jobs[index]), updatedAt: nowIso() };
	saveJobs(jobs);
}

function parseField(field, min, max) {
	const values = new Set();
	for (const rawPart of field.split(",")) {
		const part = rawPart.trim();
		if (!part) throw new Error(`Empty cron field part in "${field}"`);
		const [rangeStr, stepStr] = part.split("/");
		const step = stepStr === undefined ? 1 : Number.parseInt(stepStr, 10);
		if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step "${stepStr}" in field "${field}"`);

		let lo;
		let hi;
		if (rangeStr === "*") {
			lo = min;
			hi = max;
		} else if (rangeStr.includes("-")) {
			const [rawLo, rawHi] = rangeStr.split("-");
			lo = Number.parseInt(rawLo, 10);
			hi = Number.parseInt(rawHi, 10);
		} else {
			lo = Number.parseInt(rangeStr, 10);
			hi = lo;
		}

		if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`Invalid value in field "${field}"`);
		if (lo < min || hi > max || lo > hi) {
			throw new Error(`Value out of range in "${field}" (allowed ${min}-${max})`);
		}
		for (let value = lo; value <= hi; value += step) values.add(value);
	}
	return values;
}

function matchesCron(expression, date) {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`Invalid cron expression: ${expression}`);
	return (
		parseField(fields[0], 0, 59).has(date.getMinutes()) &&
		parseField(fields[1], 0, 23).has(date.getHours()) &&
		parseField(fields[2], 1, 31).has(date.getDate()) &&
		parseField(fields[3], 1, 12).has(date.getMonth() + 1) &&
		parseField(fields[4], 0, 6).has(date.getDay())
	);
}

function nextCronRun(expression, from = new Date()) {
	const cursor = new Date(from);
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);
	const maxChecks = 60 * 24 * 366 * 5;
	for (let i = 0; i < maxChecks; i++) {
		if (matchesCron(expression, cursor)) return new Date(cursor);
		cursor.setMinutes(cursor.getMinutes() + 1);
	}
	throw new Error(`Could not find next run for cron expression: ${expression}`);
}

function minuteKey(date) {
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

function computeInitialNextRun(job, now) {
	if (job.kind === "cron") {
		if (!job.schedule) throw new Error("cron job missing schedule");
		const last = job.lastRunAt ? new Date(job.lastRunAt) : undefined;
		if (matchesCron(job.schedule, now) && (!last || minuteKey(last) !== minuteKey(now))) {
			return now.toISOString();
		}
		return nextCronRun(job.schedule, now).toISOString();
	}
	if (!job.runAt) throw new Error(`${job.kind} job missing runAt`);
	const runAt = new Date(job.runAt);
	if (Number.isNaN(runAt.getTime())) throw new Error(`invalid runAt: ${job.runAt}`);
	return runAt.toISOString();
}

function normalizeNextRuns(jobs, now) {
	let changed = false;
	const normalized = jobs.map((job) => {
		if (!job.enabled || job.nextRunAt) return job;
		try {
			changed = true;
			return { ...job, nextRunAt: computeInitialNextRun(job, now), updatedAt: now.toISOString() };
		} catch (error) {
			log("failed to compute next run", { job: job.id, error: String(error) });
			changed = true;
			return {
				...job,
				enabled: false,
				disabledReason: "error",
				updatedAt: now.toISOString(),
			};
		}
	});
	if (changed) saveJobs(normalized);
	return normalized;
}

function isDue(job, now) {
	if (!job.enabled || !job.nextRunAt || running.has(job.id)) return false;
	const nextRunAt = new Date(job.nextRunAt);
	return !Number.isNaN(nextRunAt.getTime()) && nextRunAt.getTime() <= now.getTime();
}

function resolvePiBinary() {
	return process.env.PI_CRON_PI_BIN || "pi";
}

function runJobProcess(job, runLogPath) {
	return new Promise((resolve) => {
		const piBin = resolvePiBinary();
		const args = ["-p", "--no-session", `@${job.promptFile}`];
		const child = spawn(piBin, args, {
			cwd: job.cwd || agentDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {}
		}, DEFAULT_TIMEOUT_MS);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			stderr += `\n${error.message}`;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const exitCode = timedOut ? 124 : (code ?? 1);
			const content = [
				`# cron run: ${job.id}`,
				`startedAt: ${nowIso()}`,
				`exitCode: ${exitCode}`,
				`timedOut: ${timedOut}`,
				"",
				"## stdout",
				stdout.trimEnd(),
				"",
				"## stderr",
				stderr.trimEnd(),
				"",
			].join("\n");
			writeFileSync(runLogPath, content, "utf-8");
			resolve({ exitCode, stdout, stderr, timedOut });
		});
	});
}

async function executeJob(job) {
	running.add(job.id);
	const startedAt = new Date();
	const runId = startedAt.toISOString().replace(/[:.]/g, "-");
	const jobRunsDir = join(runsDir, job.id);
	mkdirSync(jobRunsDir, { recursive: true });
	const runLogPath = join(jobRunsDir, `${runId}.log`);

	log("job start", { job: job.id, promptFile: job.promptFile });
	updateJob(job.id, (current) => ({ ...current, running: true }));

	try {
		const result = await runJobProcess(job, runLogPath);
		const finishedAt = new Date();
		updateJob(job.id, (current) => {
			const oneShot = current.kind !== "cron" || current.once;
			const nextRunAt =
				oneShot || !current.schedule ? undefined : nextCronRun(current.schedule, finishedAt).toISOString();
			return {
				...current,
				enabled: oneShot ? false : current.enabled,
				running: false,
				lastRunAt: finishedAt.toISOString(),
				nextRunAt,
				lastExitCode: result.exitCode,
				lastRunLog: runLogPath,
				disabledReason: oneShot ? "completed_once" : current.disabledReason,
				completedAt: oneShot ? finishedAt.toISOString() : current.completedAt,
			};
		});
		log("job complete", { job: job.id, exitCode: result.exitCode, runLogPath });
	} catch (error) {
		const finishedAt = new Date();
		updateJob(job.id, (current) => {
			const oneShot = current.kind !== "cron" || current.once;
			return {
				...current,
				enabled: oneShot ? false : current.enabled,
				running: false,
				lastRunAt: finishedAt.toISOString(),
				lastExitCode: 1,
				lastRunLog: runLogPath,
				disabledReason: oneShot ? "completed_once" : "error",
				completedAt: oneShot ? finishedAt.toISOString() : current.completedAt,
			};
		});
		log("job error", { job: job.id, error: String(error) });
	} finally {
		running.delete(job.id);
	}
}

async function tick() {
	if (!lockHeld || ticking) return;
	ticking = true;
	try {
		const now = new Date();
		const jobs = normalizeNextRuns(loadJobs(), now);
		for (const job of jobs) {
			if (isDue(job, now)) void executeJob(job);
		}
	} finally {
		ticking = false;
	}
}

function startScheduler() {
	if (tickTimer) return;
	log("daemon scheduler started", { pid: process.pid });
	void tick();
	tickTimer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

function tryStart() {
	if (lockHeld) return;
	if (tryAcquireLock()) {
		startScheduler();
		return;
	}
	const holder = readPid();
	log("daemon waiting for lock", { holder });
}

function shutdown() {
	log("daemon shutting down", { pid: process.pid });
	if (tickTimer) clearInterval(tickTimer);
	if (retryTimer) clearInterval(retryTimer);
	releaseLock();
	process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (error) => {
	log("uncaught exception", { error: error.stack || String(error) });
});
process.on("unhandledRejection", (reason) => {
	log("unhandled rejection", { error: String(reason) });
});

ensureDirs();
tryStart();
retryTimer = setInterval(tryStart, RETRY_LOCK_INTERVAL_MS);
