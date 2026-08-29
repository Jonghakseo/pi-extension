import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCronDirs, getAgentDir, getDaemonErrorLogPath, getDaemonLogPath, getDaemonPidPath } from "./store.ts";
import type { DaemonStatus } from "./types.ts";

export function getDaemonPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "daemon.mjs");
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
	const pid = readDaemonPid();
	if (!pid) return { running: false };
	if (isProcessAlive(pid)) return { running: true, pid };
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

export function daemonFilesExist(): boolean {
	return existsSync(getDaemonPath());
}
