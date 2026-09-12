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

const DEFAULT_UPDATE_COMMAND_TIMEOUT_MS = 895_000;
const DEFAULT_UPDATE_FORCE_KILL_GRACE_MS = 1_000;

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

export async function upgradeDaemon(): Promise<{ ok: boolean; message: string }> {
	const desiredRuntimeId = getDaemonRuntimeId();
	const status = getDaemonStatus();
	if (!status.running || !status.pid) return { ok: true, message: "cron daemon is stopped; leaving it stopped" };
	if (!status.legacy && status.runtimeId === desiredRuntimeId) {
		return { ok: true, message: "cron daemon already uses this runtime" };
	}

	ensureCronDirs();
	const launchd = getLaunchdStatus();
	const coordinatorPath =
		process.env.PI_CRON_UPDATE_COORDINATOR_PATH ?? join(dirname(getDaemonPath()), "upgrade-coordinator.mjs");
	const timeoutMs = positiveTimeout(process.env.PI_CRON_UPDATE_COMMAND_TIMEOUT_MS, DEFAULT_UPDATE_COMMAND_TIMEOUT_MS);
	const forceKillGraceMs = positiveTimeout(
		process.env.PI_CRON_UPDATE_FORCE_KILL_GRACE_MS,
		DEFAULT_UPDATE_FORCE_KILL_GRACE_MS,
	);
	return await new Promise((resolve) => {
		const child = spawn(process.execPath, [coordinatorPath], {
			cwd: getAgentDir(),
			stdio: "ignore",
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: getAgentDir(),
				PI_CRON_UPGRADE_LAUNCHD: launchd.loaded ? "1" : "0",
			},
		});
		let settled = false;
		let timedOut = false;
		let forceKill: NodeJS.Timeout | undefined;
		const timeout = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {}
			forceKill = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				finish({ ok: false, message: `cron daemon update timed out after ${timeoutMs}ms` });
			}, forceKillGraceMs);
		}, timeoutMs);
		const finish = (result: { ok: boolean; message: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKill) clearTimeout(forceKill);
			resolve(result);
		};
		child.once("error", (error) =>
			finish({ ok: false, message: `cron daemon update could not start: ${String(error)}` }),
		);
		child.once("exit", (code, signal) => {
			if (timedOut) {
				finish({ ok: false, message: `cron daemon update timed out after ${timeoutMs}ms` });
				return;
			}
			const current = getDaemonStatus();
			const desiredOwner = current.running && !current.legacy && current.runtimeId === desiredRuntimeId;
			if (code === 0 && !signal && desiredOwner) {
				finish({ ok: true, message: `cron daemon updated to runtime ${desiredRuntimeId}` });
				return;
			}
			finish({
				ok: false,
				message: `cron daemon update did not reach the requested runtime${signal ? ` (${signal})` : code === null ? "" : ` (exit ${code})`}`,
			});
		});
	});
}

function positiveTimeout(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
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
