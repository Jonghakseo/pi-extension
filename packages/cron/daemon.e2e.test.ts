import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CronJob, CronStoreFile } from "./types.js";

const cronDirname = dirname(fileURLToPath(import.meta.url));
const daemonPath = resolve(cronDirname, "daemon.mjs");

let tempAgentDir: string;
let childPid: number | undefined;

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
	const startedAt = Date.now();
	let lastValue = read();
	while (Date.now() - startedAt < timeoutMs) {
		lastValue = read();
		if (predicate(lastValue)) return lastValue;
		await sleep(50);
	}
	throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}

function writeFakePi(): string {
	const scriptPath = join(tempAgentDir, "fake-pi.sh");
	writeFileSync(
		scriptPath,
		`#!/bin/sh
echo "$@" >> "${join(tempAgentDir, "fake-pi-args.log")}"
for arg in "$@"; do
  case "$arg" in
    @*) cat "\${arg#@}" >> "${join(tempAgentDir, "fake-pi-prompt.log")}" ;;
  esac
done
echo "fake pi ok"
exit 0
`,
		{ mode: 0o755 },
	);
	return scriptPath;
}

function readStore(): CronStoreFile {
	return JSON.parse(readFileSync(join(tempAgentDir, "cron", "jobs.json"), "utf-8"));
}

function writeStore(job: CronJob): void {
	const cronRoot = join(tempAgentDir, "cron");
	mkdirSync(join(cronRoot, "prompts"), { recursive: true });
	writeFileSync(job.promptFile, "# Test prompt\n\nSay hello from cron.\n", "utf-8");
	writeFileSync(join(cronRoot, "jobs.json"), `${JSON.stringify({ version: 1, jobs: [job] }, null, 2)}\n`, "utf-8");
}

describe("cron daemon e2e", () => {
	beforeEach(() => {
		tempAgentDir = join(tmpdir(), `pi-cron-daemon-e2e-${process.pid}-${Date.now()}-${Math.random()}`);
		mkdirSync(tempAgentDir, { recursive: true });
		childPid = undefined;
	});

	afterEach(async () => {
		if (childPid) {
			try {
				process.kill(childPid, "SIGTERM");
			} catch {}
			await sleep(100);
		}
		rmSync(tempAgentDir, { recursive: true, force: true });
	});

	it("executes a due one-shot job and leaves it disabled for history", async () => {
		const fakePi = writeFakePi();
		const job: CronJob = {
			id: "one-shot-test",
			name: "One shot test",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "one-shot-test.md"),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeStore(job);

		const child = spawn(process.execPath, [daemonPath], {
			cwd: tempAgentDir,
			detached: false,
			stdio: "ignore",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempAgentDir,
				PI_CRON_PI_BIN: fakePi,
				PI_CRON_TICK_INTERVAL_MS: "100",
				PI_CRON_RETRY_LOCK_INTERVAL_MS: "100",
				PI_CRON_JOB_TIMEOUT_MS: "2000",
			},
		});
		childPid = child.pid;

		const finalStore = await waitFor(readStore, (store) => store.jobs[0]?.disabledReason === "completed_once");
		const finalJob = finalStore.jobs[0];
		expect(finalJob.enabled).toBe(false);
		expect(finalJob.completedAt).toBeTruthy();
		expect(finalJob.lastRunAt).toBeTruthy();
		expect(finalJob.lastExitCode).toBe(0);
		expect(finalJob.lastRunLog).toBeTruthy();
		expect(existsSync(finalJob.lastRunLog as string)).toBe(true);

		const argsLog = readFileSync(join(tempAgentDir, "fake-pi-args.log"), "utf-8");
		expect(argsLog).toContain("-p --no-session");
		expect(argsLog).not.toContain("--no-extensions");
		expect(argsLog).toContain(`@${job.promptFile}`);
		expect(readFileSync(join(tempAgentDir, "fake-pi-prompt.log"), "utf-8")).toContain("Say hello from cron");
	});
});
