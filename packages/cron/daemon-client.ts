import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	daemonOwnerLiveness,
	daemonRuntimeId,
	getDaemonPath as getRuntimeDaemonPath,
	readDaemonOwner,
} from "./daemon-runtime.mjs";
import { getLaunchdStatus } from "./launchd.ts";
import {
	ensureCronDirs,
	getAgentDir,
	getCronDir,
	getDaemonErrorLogPath,
	getDaemonLogPath,
	getDaemonPidPath,
} from "./store.ts";
import type { DaemonStatus } from "./types.ts";

export function getDaemonPath(): string {
	return getRuntimeDaemonPath();
}

export function getDaemonRuntimeId(): string {
	return daemonRuntimeId();
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readDaemonPid(): number | undefined {
	try {
		const raw = readFileSync(getDaemonPidPath(), "utf-8").trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isInteger(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

export function getDaemonStatus(): DaemonStatus {
	const owner = readDaemonOwner(getCronDir());
	if (owner) {
		const liveness = daemonOwnerLiveness(owner);
		if (liveness !== "dead") return { running: true, pid: owner.pid, runtimeId: owner.runtimeId };
		return { running: false, stalePid: owner.pid, runtimeId: owner.runtimeId };
	}
	const pid = readDaemonPid();
	if (!pid) return { running: false };
	if (isProcessAlive(pid)) return { running: true, pid, legacy: true };
	return { running: false, stalePid: pid };
}

export function cleanupStaleDaemonPid(): void {
	const status = getDaemonStatus();
	if (status.stalePid) {
		try {
			unlinkSync(getDaemonPidPath());
		} catch {}
	}
}

export function startDaemon(): { ok: boolean; message: string; pid?: number } {
	ensureCronDirs();
	cleanupStaleDaemonPid();

	const status = getDaemonStatus();
	if (status.running) {
		return { ok: true, message: `cron daemon is already running (PID ${status.pid})`, pid: status.pid };
	}

	const stdoutFd = openSync(getDaemonLogPath(), "a");
	const stderrFd = openSync(getDaemonErrorLogPath(), "a");

	try {
		const child = spawn(process.execPath, [getDaemonPath()], {
			cwd: getAgentDir(),
			detached: true,
			stdio: ["ignore", stdoutFd, stderrFd],
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: getAgentDir(),
			},
		});
		child.unref();
		return { ok: true, message: `cron daemon started (PID ${child.pid})`, pid: child.pid };
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}
}

export function stopDaemon(): { ok: boolean; message: string } {
	const status = getDaemonStatus();
	if (!status.running || !status.pid) {
		cleanupStaleDaemonPid();
		return { ok: true, message: "cron daemon is not running" };
	}

	try {
		process.kill(status.pid, "SIGTERM");
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}

	return { ok: true, message: `cron daemon stop requested (PID ${status.pid})` };
}

export function scheduleDaemonUpgrade(): { scheduled: boolean; message: string; pid?: number } {
	const desiredRuntimeId = getDaemonRuntimeId();
	const status = getDaemonStatus();
	if (!status.running || !status.pid) return { scheduled: false, message: "cron daemon is stopped" };
	if (!status.legacy && status.runtimeId === desiredRuntimeId) {
		return { scheduled: false, message: "cron daemon already uses this runtime", pid: status.pid };
	}

	ensureCronDirs();
	const launchd = getLaunchdStatus();
	const coordinator = join(getAgentDir(), "cron", "daemon-upgrade-coordinator.log");
	const stdoutFd = openSync(coordinator, "a");
	try {
		const child = spawn(process.execPath, [join(dirname(getDaemonPath()), "upgrade-coordinator.mjs")], {
			cwd: getAgentDir(),
			detached: true,
			stdio: ["ignore", stdoutFd, stdoutFd],
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: getAgentDir(),
				PI_CRON_UPGRADE_LAUNCHD: launchd.loaded ? "1" : "0",
			},
		});
		child.once("error", (error) => {
			try {
				appendFileSync(coordinator, `[${new Date().toISOString()}] failed to start coordinator: ${String(error)}\n`);
			} catch {}
		});
		child.unref();
		return { scheduled: true, message: `cron daemon upgrade coordinator started (PID ${child.pid})`, pid: child.pid };
	} finally {
		closeSync(stdoutFd);
	}
}

export function daemonFilesExist(): boolean {
	return existsSync(getDaemonPath());
}
