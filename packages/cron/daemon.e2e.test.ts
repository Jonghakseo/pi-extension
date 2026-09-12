import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownProcessStartIdentity } from "./process-identity.mjs";
import { SessionBridge } from "./session-bridge.ts";
import { writeAtomicFile } from "./store-lock.mjs";
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

function writeSessionHeader(sessionId: string, sessionFile: string): void {
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`, "utf8");
}

function writeRpcFakePi(sessionId: string, sessionFile: string, settleDelayMs = 0): string {
	const scriptPath = join(tempAgentDir, "fake-pi-rpc.mjs");
	writeFileSync(
		scriptPath,
		`#!/usr/bin/env node
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ownProcessStartIdentity } from ${JSON.stringify(new URL("./process-identity.mjs", import.meta.url).href)};
const reservation = JSON.parse(process.env.PI_CRON_SESSION_RESERVATION || "null");
if (reservation) {
  const sessions = join(process.env.PI_CODING_AGENT_DIR, "cron", "sessions");
  mkdirSync(sessions, { recursive: true });
  const key = createHash("sha256").update(reservation.sessionId).digest("hex").slice(0, 24);
  const lock = join(sessions, key + "-" + reservation.generation + ".adopt");
  closeSync(openSync(lock, "wx", 0o600));
  writeFileSync(join(sessions, key + ".json"), JSON.stringify({ ...reservation, pid: process.pid, processIdentity: ownProcessStartIdentity(), endpoint: join(sessions, "rpc-" + reservation.generation + ".sock"), state: "active" }));
}
appendFileSync(${JSON.stringify(join(tempAgentDir, "fake-pi-rpc-start.log"))}, "start\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.type === "get_state") {
      process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "get_state", success: true, data: { sessionId: ${JSON.stringify(sessionId)}, sessionFile: reservation?.sessionFile || ${JSON.stringify(sessionFile)} } }) + "\\n");
    }
    if (request.type === "prompt") {
      appendFileSync(${JSON.stringify(join(tempAgentDir, "fake-pi-rpc-prompt.log"))}, request.message);
      process.stdout.write(JSON.stringify({ id: "stray-prompt", type: "response", command: "prompt", success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "prompt", success: true }) + "\\n");
      setTimeout(() => { appendFileSync(${JSON.stringify(join(tempAgentDir, "fake-pi-rpc-settled.log"))}, "settled\\n"); process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"); }, ${settleDelayMs});
    }
  }
});
appendFileSync(${JSON.stringify(join(tempAgentDir, "fake-pi-args.log"))}, process.argv.slice(2).join(" ") + "\\n");
`,
		{ mode: 0o755 },
	);
	return scriptPath;
}

function writeImmediateCommandRpcFake(sessionId: string): string {
	const scriptPath = join(tempAgentDir, "fake-pi-rpc-command.mjs");
	writeFileSync(
		scriptPath,
		`#!/usr/bin/env node
import { appendFileSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ownProcessStartIdentity } from ${JSON.stringify(new URL("./process-identity.mjs", import.meta.url).href)};
const reservation = JSON.parse(process.env.PI_CRON_SESSION_RESERVATION || "null");
const sessions = join(process.env.PI_CODING_AGENT_DIR, "cron", "sessions");
mkdirSync(sessions, { recursive: true });
const key = createHash("sha256").update(reservation.sessionId).digest("hex").slice(0, 24);
closeSync(openSync(join(sessions, key + "-" + reservation.generation + ".adopt"), "wx", 0o600));
writeFileSync(join(sessions, key + ".json"), JSON.stringify({ ...reservation, pid: process.pid, processIdentity: ownProcessStartIdentity(), endpoint: join(sessions, "rpc.sock"), state: "active" }));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.type === "get_state") {
      process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "get_state", success: true, data: { sessionId: ${JSON.stringify(sessionId)}, sessionFile: reservation.sessionFile, isStreaming: false, isCompacting: false, pendingMessageCount: 0 } }) + "\\n");
    }
    if (request.type === "prompt") {
      appendFileSync(${JSON.stringify(join(tempAgentDir, "immediate-command.log"))}, request.message);
      process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "prompt", success: true }) + "\\n");
    }
  }
});
`,
		{ mode: 0o755 },
	);
	return scriptPath;
}

function writeTermIgnoringFakePi(): string {
	const scriptPath = join(tempAgentDir, "fake-pi-ignore-term.mjs");
	writeFileSync(
		scriptPath,
		`#!/usr/bin/env node
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
		{ mode: 0o755 },
	);
	return scriptPath;
}

function readStore(): CronStoreFile {
	return JSON.parse(readFileSync(join(tempAgentDir, "cron", "jobs.json"), "utf-8"));
}

function writeStore(...jobs: CronJob[]): void {
	const cronRoot = join(tempAgentDir, "cron");
	mkdirSync(join(cronRoot, "prompts"), { recursive: true });
	for (const job of jobs) {
		writeFileSync(job.promptFile, "# Test prompt\n\nSay hello from cron.\n", "utf-8");
		if (job.sessionId && job.sessionFile) writeSessionHeader(job.sessionId, job.sessionFile);
	}
	writeFileSync(join(cronRoot, "jobs.json"), `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, "utf-8");
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

	it("executes a due one-shot job and moves it out of current jobs into history", async () => {
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

		const finalStore = await waitFor(readStore, (store) => store.jobs.length === 0 && store.history.length === 1);
		const finalJob = finalStore.history[0];
		expect(finalStore.version).toBe(2);
		expect(finalJob.enabled).toBe(false);
		expect(finalJob.completedAt).toBeTruthy();
		expect(finalJob.lastRunAt).toBeTruthy();
		expect(finalJob.lastExitCode).toBe(0);
		expect(finalJob.lastRunLog).toBeTruthy();
		expect(existsSync(finalJob.lastRunLog as string)).toBe(true);

		const argsLog = readFileSync(join(tempAgentDir, "fake-pi-args.log"), "utf-8");
		expect(argsLog).toContain("-p --no-session");
		expect(argsLog).not.toContain("--no-extensions");
		expect(argsLog).toContain("cron/runs/one-shot-test/");
		expect(readFileSync(join(tempAgentDir, "fake-pi-prompt.log"), "utf-8")).toContain("Say hello from cron");
	});

	it("preserves a concurrent extension upsert while the daemon completes a job", async () => {
		const releasePath = join(tempAgentDir, "release-job");
		const fakePi = join(tempAgentDir, "fake-pi-wait.sh");
		writeFileSync(fakePi, `#!/bin/sh\nwhile [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.01; done\n`, {
			mode: 0o755,
		});
		const job: CronJob = {
			id: "daemon-job",
			name: "Daemon job",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "daemon-job.md"),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeStore(job);
		const child = spawn(process.execPath, [daemonPath], {
			cwd: tempAgentDir,
			stdio: "ignore",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempAgentDir,
				PI_CRON_PI_BIN: fakePi,
				PI_CRON_TICK_INTERVAL_MS: "30",
				PI_CRON_RETRY_LOCK_INTERVAL_MS: "30",
			},
		});
		childPid = child.pid;
		await waitFor(readStore, (store) =>
			store.jobs.some((candidate) => candidate.id === "daemon-job" && candidate.running),
		);

		const writerPath = join(tempAgentDir, "concurrent-extension-upsert.mjs");
		writeFileSync(
			writerPath,
			`import { join } from "node:path";
import { upsertJob } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
const now = new Date().toISOString();
upsertJob({ id: "extension-job", name: "Extension job", enabled: true, kind: "cron", once: false, schedule: "0 10 * * *", timezone: "UTC", cwd: process.env.PI_CODING_AGENT_DIR, promptFile: join(process.env.PI_CODING_AGENT_DIR, "cron", "prompts", "extension-job.md"), createdAt: now, updatedAt: now });
`,
		);
		const writer = spawnSync(process.execPath, ["--experimental-strip-types", writerPath], {
			env: { ...process.env, PI_CODING_AGENT_DIR: tempAgentDir },
			encoding: "utf8",
		});
		expect(writer.status, writer.stderr).toBe(0);
		writeFileSync(releasePath, "release");

		const finalStore = await waitFor(readStore, (store) =>
			store.history.some((candidate) => candidate.id === "daemon-job"),
		);
		expect(finalStore.jobs.map((candidate) => candidate.id)).toEqual(["extension-job"]);
	});

	it("keeps a claimed prompt snapshot and does not complete a replacement job with the same id", async () => {
		const releasePath = join(tempAgentDir, "release-snapshot");
		const observedPath = join(tempAgentDir, "observed-prompt");
		const fakePi = join(tempAgentDir, "fake-pi-snapshot.sh");
		writeFileSync(
			fakePi,
			`#!/bin/sh\nwhile [ ! -f ${JSON.stringify(releasePath)} ]; do sleep 0.01; done\nfor arg in "$@"; do case "$arg" in @*) cat "\${arg#@}" > ${JSON.stringify(observedPath)} ;; esac; done\n`,
			{ mode: 0o755 },
		);
		const oldJob: CronJob = {
			id: "same-id",
			name: "old job",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "same-id.md"),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeStore(oldJob);
		const child = spawn(process.execPath, [daemonPath], {
			cwd: tempAgentDir,
			stdio: "ignore",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempAgentDir,
				PI_CRON_PI_BIN: fakePi,
				PI_CRON_TICK_INTERVAL_MS: "20",
				PI_CRON_RETRY_LOCK_INTERVAL_MS: "20",
			},
		});
		childPid = child.pid;
		await waitFor(readStore, (store) => store.jobs[0]?.running === true);
		const replacementRunAt = new Date(Date.now() + 86_400_000).toISOString();
		const writerPath = join(tempAgentDir, "replace-claimed-job.mjs");
		writeFileSync(
			writerPath,
			`import { removeJob, upsertJob, writePromptFile } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
const now = new Date().toISOString();
removeJob("same-id");
const promptFile = writePromptFile("same-id", "NEW MUTABLE PROMPT");
upsertJob({ id: "same-id", name: "replacement", enabled: true, kind: "at", once: true, runAt: ${JSON.stringify(replacementRunAt)}, nextRunAt: ${JSON.stringify(replacementRunAt)}, timezone: "UTC", cwd: process.env.PI_CODING_AGENT_DIR, promptFile, createdAt: now, updatedAt: now });
`,
		);
		const writer = spawnSync(process.execPath, ["--experimental-strip-types", writerPath], {
			env: { ...process.env, PI_CODING_AGENT_DIR: tempAgentDir },
			encoding: "utf8",
		});
		expect(writer.status, writer.stderr).toBe(0);
		writeFileSync(releasePath, "go");
		await waitFor(() => existsSync(observedPath), Boolean);
		await sleep(100);
		const finalStore = readStore();
		expect(readFileSync(observedPath, "utf8")).toContain("Say hello from cron.");
		expect(finalStore.jobs).toMatchObject([{ id: "same-id", name: "replacement", enabled: true }]);
		expect(finalStore.history).toEqual([]);
	});

	it("settles an immediate RPC extension command and removes the storage delimiter", async () => {
		const sessionId = "immediate-command-session";
		const sessionFile = join(tempAgentDir, "source.jsonl");
		const fakePi = writeImmediateCommandRpcFake(sessionId);
		const job: CronJob = {
			id: "immediate-command",
			name: "immediate command",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "immediate-command.md"),
			scope: "session",
			sessionId,
			sessionFile,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeStore(job);
		writeFileSync(job.promptFile, "/probe\n");
		const child = spawn(process.execPath, [daemonPath], {
			cwd: tempAgentDir,
			stdio: "ignore",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempAgentDir,
				PI_CRON_PI_BIN: fakePi,
				PI_CRON_TICK_INTERVAL_MS: "20",
				PI_CRON_RETRY_LOCK_INTERVAL_MS: "20",
				PI_CRON_JOB_TIMEOUT_MS: "1000",
			},
		});
		childPid = child.pid;
		const finalStore = await waitFor(readStore, (store) => store.history?.length === 1);
		expect(readFileSync(join(tempAgentDir, "immediate-command.log"), "utf8")).toBe("/probe");
		expect(finalStore.history[0].lastDeliveryOutcome).toBe("settled");
		expect(finalStore.history[0].lastDeliveryError).toBeUndefined();
	});

	it("resumes a closed session through RPC and waits for settlement instead of using --no-session", async () => {
		const sessionId = "source-session";
		const sessionFile = join(tempAgentDir, "source.jsonl");
		const fakePi = writeRpcFakePi(sessionId, sessionFile, 250);
		const job: CronJob = {
			id: "session-one-shot",
			name: "Session one shot",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "session-one-shot.md"),
			scope: "session",
			sessionId,
			sessionFile,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		const secondJob: CronJob = {
			...job,
			id: "session-one-shot-second",
			name: "Session one shot second",
			promptFile: join(tempAgentDir, "cron", "prompts", "session-one-shot-second.md"),
		};
		writeStore(job, secondJob);
		const child = spawn(process.execPath, [daemonPath], {
			cwd: tempAgentDir,
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
		await waitFor(() => existsSync(join(tempAgentDir, "fake-pi-rpc-prompt.log")), Boolean);
		const whileSettling = readStore();
		expect(whileSettling.jobs).toHaveLength(2);
		expect(whileSettling.jobs.filter((candidate) => candidate.running)).toHaveLength(1);
		expect(readFileSync(join(tempAgentDir, "fake-pi-rpc-start.log"), "utf8").trim().split("\n")).toHaveLength(1);
		const finalStore = await waitFor(readStore, (store) => store.jobs.length === 0 && store.history.length === 2);
		const finalJob = finalStore.history.find((candidate) => candidate.id === job.id) as CronJob;
		const args = readFileSync(join(tempAgentDir, "fake-pi-args.log"), "utf8");
		expect(args).toContain(`--mode rpc --session ${realpathSync(sessionFile)}`);
		expect(args).not.toContain("--no-session");
		expect(readFileSync(join(tempAgentDir, "fake-pi-rpc-prompt.log"), "utf8")).toContain("Say hello from cron");
		expect(readFileSync(finalJob.lastRunLog as string, "utf8")).toContain("outcome: settled");
		expect(finalJob.lastDeliveryOutcome).toBe("settled");
		expect(finalJob.lastExitCode).toBeUndefined();
	});

	it.each([
		"reserved",
		"starting",
		"draining",
	])("defers a due one-shot while its owner is %s, then delivers once active", async (state) => {
		const sessionId = "starting-session";
		const sessionFile = join(tempAgentDir, "source.jsonl");
		const job: CronJob = {
			id: "starting-session-job",
			name: "starting session job",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "starting-session-job.md"),
			scope: "session",
			sessionId,
			sessionFile,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeStore(job);
		const fakePi = writeFakePi();
		const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
		const sessionsDir = join(tempAgentDir, "cron", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(
			join(sessionsDir, `${key}.json`),
			JSON.stringify({
				sessionId,
				sessionFile: realpathSync(sessionFile),
				endpoint: join(tempAgentDir, "not-ready.sock"),
				pid: process.pid,
				generation: "starting-owner",
				state,
			}),
		);
		const child = spawn(process.execPath, [daemonPath], {
			cwd: tempAgentDir,
			stdio: "ignore",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempAgentDir,
				PI_CRON_PI_BIN: fakePi,
				PI_CRON_TICK_INTERVAL_MS: "20",
				PI_CRON_RETRY_LOCK_INTERVAL_MS: "20",
			},
		});
		childPid = child.pid;
		const logPath = join(tempAgentDir, "cron", "daemon.log");
		await waitFor(
			() => (existsSync(logPath) ? readFileSync(logPath, "utf8") : ""),
			(log) => log.includes("session delivery deferred"),
		);
		const deferredStore = await waitFor(readStore, (store) => store.jobs[0]?.running === false);
		expect(deferredStore).toMatchObject({ jobs: [{ id: job.id, running: false }], history: [] });
		expect(existsSync(join(tempAgentDir, "fake-pi-args.log"))).toBe(false);

		child.kill("SIGTERM");
		await sleep(100);
		unlinkSync(join(sessionsDir, `${key}.json`));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tempAgentDir;
		const delivered: string[] = [];
		const bridge = new SessionBridge(sessionId, sessionFile, {
			sendUserMessage: (message: string) => delivered.push(message),
		} as never);
		await bridge.start();
		try {
			const resumedDaemon = spawn(process.execPath, [daemonPath], {
				cwd: tempAgentDir,
				stdio: "ignore",
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: tempAgentDir,
					PI_CRON_TICK_INTERVAL_MS: "20",
					PI_CRON_RETRY_LOCK_INTERVAL_MS: "20",
				},
			});
			childPid = resumedDaemon.pid;
			const finalStore = await waitFor(readStore, (store) => store.jobs.length === 0 && store.history.length === 1);
			expect(delivered).toEqual(["# Test prompt\n\nSay hello from cron."]);
			expect(finalStore.history[0].lastDeliveryOutcome).toBe("queued");
			expect(existsSync(join(tempAgentDir, "fake-pi-args.log"))).toBe(false);
		} finally {
			await bridge.stop();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("delivers to a real live bridge without spawning a child session owner", async () => {
		const sessionId = "live-session";
		const sessionFile = join(tempAgentDir, "source.jsonl");
		const job: CronJob = {
			id: "live-session-job",
			name: "Live session job",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "live-session-job.md"),
			scope: "session",
			sessionId,
			sessionFile,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeStore(job);
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tempAgentDir;
		const delivered: string[] = [];
		const pi = { sendUserMessage: (message: string) => delivered.push(message) };
		const bridge = new SessionBridge(sessionId, sessionFile, pi as never);
		await bridge.start();
		try {
			const child = spawn(process.execPath, [daemonPath], {
				cwd: tempAgentDir,
				stdio: "ignore",
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: tempAgentDir,
					PI_CRON_TICK_INTERVAL_MS: "100",
					PI_CRON_RETRY_LOCK_INTERVAL_MS: "100",
				},
			});
			childPid = child.pid;
			const finalStore = await waitFor(readStore, (store) => store.jobs.length === 0 && store.history.length === 1);
			expect(delivered).toEqual(["# Test prompt\n\nSay hello from cron."]);
			expect(finalStore.history[0].lastDeliveryOutcome).toBe("queued");
			expect(existsSync(join(tempAgentDir, "fake-pi-args.log"))).toBe(false);
		} finally {
			await bridge.stop();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("does not replay an ambiguously accepted delivery when its owner starts draining", async () => {
		const sessionId = "lost-ack-session";
		const sessionFile = join(tempAgentDir, "source.jsonl");
		const job: CronJob = {
			id: "lost-ack-job",
			name: "lost acknowledgement",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "lost-ack-job.md"),
			scope: "session",
			sessionId,
			sessionFile,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeStore(job);
		const fakePi = writeFakePi();
		const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
		const registryPath = join(tempAgentDir, "cron", "sessions", `${key}.json`);
		const endpoint = join("/tmp", `cron-lost-ack-${process.pid}-${Date.now()}.sock`);
		const owner = {
			sessionId,
			sessionFile: realpathSync(sessionFile),
			endpoint,
			pid: process.pid,
			processIdentity: ownProcessStartIdentity(),
			generation: "lost-ack-owner",
			state: "active",
		};
		mkdirSync(dirname(registryPath), { recursive: true });
		const accepted: string[] = [];
		const server = createServer((socket) => {
			let input = "";
			let handled = false;
			socket.setEncoding("utf8");
			socket.on("error", () => {});
			socket.on("data", (chunk) => {
				input += chunk;
				if (handled || !input.includes("\n")) return;
				handled = true;
				accepted.push(JSON.parse(input.slice(0, input.indexOf("\n"))).prompt);
				writeAtomicFile(registryPath, JSON.stringify({ ...owner, state: "draining" }));
				// Acceptance happened, but the acknowledgement is lost during teardown.
				socket.destroy();
			});
		});
		try {
			await new Promise<void>((resolveListen, reject) => {
				server.once("error", reject);
				server.listen(endpoint, resolveListen);
			});
			writeAtomicFile(registryPath, JSON.stringify(owner));
			const child = spawn(process.execPath, [daemonPath], {
				cwd: tempAgentDir,
				stdio: "ignore",
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: tempAgentDir,
					PI_CRON_PI_BIN: fakePi,
					PI_CRON_TICK_INTERVAL_MS: "20",
				},
			});
			childPid = child.pid;
			const store = await waitFor(readStore, (value) => value.history?.length === 1);
			expect(store.jobs).toEqual([]);
			expect(store.history[0].lastDeliveryOutcome).toBe("failed");
			expect(accepted).toEqual(["# Test prompt\n\nSay hello from cron."]);
			expect(existsSync(join(tempAgentDir, "fake-pi-args.log"))).toBe(false);
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			rmSync(endpoint, { force: true });
		}
	});

	it("does not spawn another session writer when a live owner is unreachable", async () => {
		const sessionId = "live-but-unreachable";
		const sessionFile = join(tempAgentDir, "source.jsonl");
		const fakePi = writeFakePi();
		const job: CronJob = {
			id: "live-session-job",
			name: "Live session job",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "live-session-job.md"),
			scope: "session",
			sessionId,
			sessionFile,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeStore(job);
		const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
		const sessionsDir = join(tempAgentDir, "cron", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(
			join(sessionsDir, `${key}.json`),
			JSON.stringify({
				sessionId,
				sessionFile: realpathSync(sessionFile),
				endpoint: join(tempAgentDir, "missing.sock"),
				pid: process.pid,
				generation: "live-owner",
				state: "active",
			}),
		);
		const child = spawn(process.execPath, [daemonPath], {
			cwd: tempAgentDir,
			stdio: "ignore",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempAgentDir,
				PI_CRON_PI_BIN: fakePi,
				PI_CRON_TICK_INTERVAL_MS: "100",
				PI_CRON_RETRY_LOCK_INTERVAL_MS: "100",
				PI_CRON_SESSION_DELIVERY_TIMEOUT_MS: "100",
			},
		});
		childPid = child.pid;
		const finalStore = await waitFor(readStore, (store) => store.jobs.length === 0 && store.history.length === 1);
		expect(finalStore.history[0].lastExitCode).toBe(1);
		expect(finalStore.history[0].lastDeliveryOutcome).toBe("failed");
		expect(readFileSync(finalStore.history[0].lastRunLog as string, "utf8")).toContain("connect");
		expect(existsSync(join(tempAgentDir, "fake-pi-args.log"))).toBe(false);
	});

	it("kills a term-ignoring job after the timeout grace period and archives it", async () => {
		const fakePi = writeTermIgnoringFakePi();
		const job: CronJob = {
			id: "timeout-test",
			name: "Timeout test",
			enabled: true,
			kind: "at",
			once: true,
			runAt: new Date(Date.now() - 1000).toISOString(),
			timezone: "UTC",
			cwd: tempAgentDir,
			promptFile: join(tempAgentDir, "cron", "prompts", "timeout-test.md"),
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
				PI_CRON_JOB_TIMEOUT_MS: "100",
				PI_CRON_JOB_KILL_GRACE_MS: "100",
			},
		});
		childPid = child.pid;

		const finalStore = await waitFor(readStore, (store) => store.jobs.length === 0 && store.history.length === 1);
		const finalJob = finalStore.history[0];
		expect(finalJob.lastExitCode).toBe(124);
		expect(readFileSync(finalJob.lastRunLog as string, "utf-8")).toContain("timedOut: true");
		expect(child.exitCode).toBeNull();
	});
});
