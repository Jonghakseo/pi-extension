#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
	daemonOwnerExists,
	daemonOwnerLiveness,
	daemonRuntimeId,
	getDaemonPath,
	readDaemonOwner,
} from "./daemon-runtime.mjs";
import { processLiveness, processStartIdentity } from "./process-identity.mjs";
import { releaseFileLock, tryAcquireFileLock } from "./store-lock.mjs";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const cronDir = join(agentDir, "cron");
const pidPath = join(cronDir, "daemon.pid");
const logPath = join(cronDir, "daemon.log");
const errorLogPath = join(cronDir, "daemon.err.log");
const DEFAULT_JOB_TIMEOUT_MS = Number.parseInt(process.env.PI_CRON_JOB_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const KILL_GRACE_MS = Number.parseInt(process.env.PI_CRON_JOB_KILL_GRACE_MS || "5000", 10);
const UPGRADE_TIMEOUT_MS = Number.parseInt(
	process.env.PI_CRON_UPGRADE_TIMEOUT_MS || String(DEFAULT_JOB_TIMEOUT_MS + KILL_GRACE_MS + 60_000),
	10,
);
const RESTART_TIMEOUT_MS = Number.parseInt(process.env.PI_CRON_UPGRADE_RESTART_TIMEOUT_MS || "30000", 10);
const LAUNCHD_GRACE_MS = Number.parseInt(process.env.PI_CRON_UPGRADE_LAUNCHD_GRACE_MS || "1000", 10);
const POLL_MS = Number.parseInt(process.env.PI_CRON_UPGRADE_POLL_MS || "50", 10);
const desiredRuntimeId = daemonRuntimeId();
const desiredDaemonPath = getDaemonPath();

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message, details = undefined) {
	mkdirSync(cronDir, { recursive: true });
	const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
	try {
		appendFileSync(logPath, `[${new Date().toISOString()}] daemon upgrade: ${message}${suffix}\n`);
	} catch {}
}

function readPid() {
	try {
		const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
		return Number.isInteger(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function activeDaemon() {
	const owner = readDaemonOwner(cronDir);
	if (owner) {
		if (daemonOwnerLiveness(owner) === "alive") return { pid: owner.pid, identity: owner.processIdentity, owner };
		// A runtime record binds the PID to its process-start identity. Never downgrade a stale or
		// recycled record to the unverified legacy PID path.
		return undefined;
	}
	if (daemonOwnerExists(cronDir)) return undefined;
	const pid = readPid();
	if (!pid || !pidAlive(pid)) return undefined;
	const identity = processStartIdentity(pid);
	return identity ? { pid, identity, owner: undefined } : undefined;
}

function isDesiredDaemon() {
	const owner = readDaemonOwner(cronDir);
	return Boolean(owner && owner.runtimeId === desiredRuntimeId && daemonOwnerLiveness(owner) === "alive");
}

async function waitForExit(pid, identity, deadline) {
	while (Date.now() < deadline) {
		if (processLiveness(pid, identity) === "dead") return true;
		await sleep(POLL_MS);
	}
	return processLiveness(pid, identity) === "dead";
}

function processCommandContains(pid, expectedPath) {
	try {
		if (platform() === "linux") {
			const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
			return args.includes(expectedPath);
		}
		if (platform() === "darwin") {
			const result = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
				encoding: "utf8",
				timeout: 1000,
			});
			return result.status === 0 && result.stdout.includes(expectedPath);
		}
	} catch {}
	return false;
}

function directChildren(pid) {
	try {
		const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 1000 });
		if (result.status !== 0) return undefined;
		return result.stdout
			.split("\n")
			.map((line) => line.trim().split(/\s+/).map(Number))
			.filter(([childPid, parentPid]) => Number.isInteger(childPid) && Number.isInteger(parentPid))
			.filter(([, parentPid]) => parentPid === pid)
			.map(([childPid]) => childPid);
	} catch {
		return undefined;
	}
}

async function fenceLegacyDaemon(active, deadline) {
	const expectedPath = process.env.PI_CRON_TEST_LEGACY_DAEMON_PATH || desiredDaemonPath;
	while (Date.now() < deadline) {
		const liveness = processLiveness(active.pid, active.identity);
		if (liveness === "dead") return true;
		if (liveness !== "alive" || !processCommandContains(active.pid, expectedPath)) {
			log("refusing to replace unverifiable legacy daemon", { pid: active.pid });
			return false;
		}
		const before = directChildren(active.pid);
		if (before === undefined) return false;
		if (before.length > 0) {
			await sleep(POLL_MS);
			continue;
		}
		try {
			process.kill(active.pid, "SIGSTOP");
		} catch {
			return processLiveness(active.pid, active.identity) === "dead";
		}
		const frozenChildren = directChildren(active.pid);
		if (
			processLiveness(active.pid, active.identity) !== "alive" ||
			!processCommandContains(active.pid, expectedPath) ||
			frozenChildren === undefined ||
			frozenChildren.length > 0
		) {
			try {
				process.kill(active.pid, "SIGCONT");
			} catch {}
			await sleep(POLL_MS);
			continue;
		}
		try {
			// SIGKILL is delivered while stopped. This compatibility path runs only for a frozen, childless legacy daemon.
			process.kill(active.pid, "SIGKILL");
		} catch {
			try {
				process.kill(active.pid, "SIGCONT");
			} catch {}
			return false;
		}
		return waitForExit(active.pid, active.identity, deadline);
	}
	return false;
}

async function requestDrain(active, deadline) {
	if (!active.owner) return fenceLegacyDaemon(active, deadline);
	try {
		process.kill(active.pid, "SIGUSR2");
	} catch {
		return processLiveness(active.pid, active.identity) === "dead";
	}
	return waitForExit(active.pid, active.identity, deadline);
}

function kickstartLaunchd() {
	const launchctl = process.env.PI_CRON_LAUNCHCTL_BIN || "launchctl";
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const target = uid === undefined ? "dev.pi.cron" : `gui/${uid}/dev.pi.cron`;
	const result = spawnSync(launchctl, ["kickstart", target], { encoding: "utf8", timeout: 10_000 });
	return { ok: result.status === 0, output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() };
}

function startManualDaemon() {
	const stdout = openSync(logPath, "a");
	const stderr = openSync(errorLogPath, "a");
	try {
		const child = spawn(process.execPath, [desiredDaemonPath], {
			cwd: agentDir,
			detached: true,
			stdio: ["ignore", stdout, stderr],
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		child.unref();
		return child.pid;
	} finally {
		closeSync(stdout);
		closeSync(stderr);
	}
}

async function waitForDesiredOwner(deadline) {
	while (Date.now() < deadline) {
		if (isDesiredDaemon()) return true;
		await sleep(POLL_MS);
	}
	return isDesiredDaemon();
}

async function coordinate() {
	mkdirSync(cronDir, { recursive: true });
	const lockPath = join(cronDir, "daemon-upgrade.lock");
	const marker = tryAcquireFileLock(lockPath);
	if (!marker) {
		log("another coordinator is active");
		return { ok: false, reason: "another coordinator is active" };
	}
	try {
		if (isDesiredDaemon()) {
			log("already current", { runtimeId: desiredRuntimeId });
			return { ok: true, running: true };
		}
		const active = activeDaemon();
		if (!active) {
			log("no daemon is running; leaving it stopped");
			return { ok: true, running: false };
		}
		const drainTimeoutMs = active.owner?.drainTimeoutMs ?? UPGRADE_TIMEOUT_MS;
		const deadline = Date.now() + drainTimeoutMs;
		log("draining outdated daemon", { pid: active.pid, legacy: !active.owner, drainTimeoutMs });
		if (!(await requestDrain(active, deadline))) {
			log("drain timed out; old daemon left running", { pid: active.pid });
			return { ok: false, reason: "drain timed out" };
		}
		if (process.env.PI_CRON_UPGRADE_LAUNCHD === "1") {
			if (await waitForDesiredOwner(Date.now() + LAUNCHD_GRACE_MS)) {
				log("launchd restarted current daemon");
				return { ok: true, running: true };
			}
			const kickstart = kickstartLaunchd();
			if (!kickstart.ok) {
				log("launchd kickstart failed", { output: kickstart.output });
				return { ok: false, reason: "launchd kickstart failed" };
			}
			if (await waitForDesiredOwner(Date.now() + RESTART_TIMEOUT_MS)) {
				log("launchd kickstarted current daemon");
				return { ok: true, running: true };
			}
			log("launchd did not restart daemon before timeout");
			return { ok: false, reason: "launchd did not restart daemon" };
		}
		const pid = startManualDaemon();
		if (await waitForDesiredOwner(Date.now() + RESTART_TIMEOUT_MS)) {
			log("manual daemon replaced", { pid });
			return { ok: true, running: true };
		}
		log("manual replacement did not acquire scheduler lock", { pid });
		return { ok: false, reason: "manual replacement did not acquire scheduler lock" };
	} finally {
		releaseFileLock(lockPath, marker);
	}
}

coordinate()
	.then((result) => {
		if (!result.ok) process.exitCode = 1;
	})
	.catch((error) => {
		log("coordinator failed", { error: String(error) });
		process.exitCode = 1;
	});
