import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import * as path from "node:path";
import { resolveSetupContext } from "./context.js";
import { createLock, ensureStateDirs, finalizeRunIfNeeded } from "./state.js";
import type { LockRecord, RunRecord, SetupContext, StartMode, StartResult } from "./types.js";
import { isoNow, isPidAlive, maybeUnlink, shellQuote, writeJsonAtomic } from "./utils.js";

export function createWrapperScript(record: LockRecord, wrapperPath: string): string {
	const setupPath = shellQuote(record.setupPath);
	const repoRoot = shellQuote(record.repoRoot);
	const lockPath = shellQuote(record.lockPath);
	const exitPath = shellQuote(record.exitPath);
	return `#!/bin/zsh
set +e
write_exit() {
  local code="$1"
  local setup_status="failed"
  if [ "$code" = "0" ]; then
    setup_status="success"
  elif [ "$code" = "130" ] || [ "$code" = "143" ]; then
    setup_status="cancelled"
  fi
  local finished_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"status":"%s","exitCode":%s,"finishedAt":"%s"}\n' "$setup_status" "$code" "$finished_at" > ${exitPath}.tmp
  mv ${exitPath}.tmp ${exitPath}
  rm -f ${lockPath}
}
trap 'write_exit 130; exit 130' INT TERM HUP
printf '▶ setup.sh start %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
cd ${repoRoot}
/bin/zsh ${setupPath}
code=$?
write_exit "$code"
printf '■ setup.sh exit %s\n' "$code"
rm -f ${shellQuote(wrapperPath)}
exit "$code"
`;
}

function initialLockRecord(context: SetupContext, runId: string, startedAt: string): LockRecord {
	const logPath = path.join(context.paths.logsDir, `${context.repoKey}-${runId}.log`);
	const exitPath = path.join(context.paths.exitsDir, `${context.repoKey}-${runId}.exit.json`);
	return {
		repoKey: context.repoKey,
		repoRoot: context.repoRoot,
		setupPath: context.setupPath,
		setupHash: context.setupHash,
		runId,
		pid: process.pid,
		coordinatorPid: process.pid,
		startedAt,
		logPath,
		exitPath,
		lockPath: context.paths.lockPath,
	};
}

async function handleLockedSetup(context: SetupContext): Promise<StartResult> {
	const running = await finalizeRunIfNeeded(context);
	return running?.status === "running"
		? { kind: "running", context, record: running, owner: running.coordinatorPid === process.pid ? "self" : "other" }
		: { kind: "skipped", context, record: running ?? undefined, reason: "setup.sh is locked by another session" };
}

export function waitForChildSpawn(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else resolve();
		};
		child.once("spawn", () => settle());
		// Keep this one-shot listener installed after spawn so a later process error is never unhandled.
		child.once("error", (error) => settle(error));
	});
}

function sendSetupSignal(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {}
	}
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (exited: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off("exit", onExit);
			resolve(exited);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref();
		child.once("exit", onExit);
	});
}

async function terminateSpawnedSetup(child: ChildProcess): Promise<void> {
	sendSetupSignal(child, "SIGTERM");
	if (await waitForChildExit(child, 1_000)) return;
	sendSetupSignal(child, "SIGKILL");
	await waitForChildExit(child, 1_000);
}

async function spawnSetup(context: SetupContext, record: LockRecord, mode: StartMode): Promise<StartResult> {
	const wrapperPath = path.join(context.paths.wrappersDir, `${context.repoKey}-${record.runId}.zsh`);
	let logFd: number | undefined;
	let child: ChildProcess | undefined;
	let childStarted = false;
	let stateCommitted = false;
	let exitObserved = false;

	try {
		logFd = openSync(record.logPath, "a");
		writeFileSync(wrapperPath, createWrapperScript(record, wrapperPath), "utf-8");
		await chmod(wrapperPath, 0o700);
		child = spawn("/bin/zsh", [wrapperPath], {
			cwd: context.repoRoot,
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: process.env,
		});
		child.on("exit", () => {
			exitObserved = true;
			if (stateCommitted) void finalizeRunIfNeeded(context).catch(() => {});
		});

		await waitForChildSpawn(child);
		childStarted = true;
		if (!child.pid) throw new Error("Failed to start setup.sh");

		const run: RunRecord = { ...record, pid: child.pid, status: "running", mode };
		await writeJsonAtomic(context.paths.lockPath, run);
		await writeJsonAtomic(context.paths.statePath, run);
		stateCommitted = true;
		child.unref();
		if (exitObserved) void finalizeRunIfNeeded(context).catch(() => {});
		return { kind: "started", context, record: run };
	} catch (error) {
		if (childStarted && child) await terminateSpawnedSetup(child);
		await maybeUnlink(context.paths.lockPath);
		await maybeUnlink(wrapperPath);
		const failed: RunRecord = {
			...record,
			status: "failed",
			mode,
			finishedAt: isoNow(),
			message: error instanceof Error ? error.message : String(error),
		};
		try {
			await writeJsonAtomic(context.paths.statePath, failed);
		} catch {}
		return { kind: "failed", context, reason: failed.message ?? "Failed to start setup.sh" };
	} finally {
		if (logFd !== undefined) closeSync(logFd);
	}
}

export async function startSetup(cwd: string, mode: StartMode): Promise<StartResult> {
	let context: SetupContext | null = null;
	try {
		context = resolveSetupContext(cwd);
	} catch (error) {
		return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
	}

	if (!context) return { kind: "no-setup", reason: "setup.sh not found" };
	await ensureStateDirs(context.paths);
	const current = await finalizeRunIfNeeded(context);
	if (current?.status === "running") {
		return {
			kind: "running",
			context,
			record: current,
			owner: current.coordinatorPid === process.pid ? "self" : "other",
		};
	}

	if (mode === "auto" && current?.status === "success" && current.setupHash === context.setupHash) {
		return { kind: "skipped", context, record: current, reason: "setup.sh already completed for this folder" };
	}

	const runId = `${Date.now()}-${process.pid}`;
	const record = initialLockRecord(context, runId, isoNow());
	const lockResult = await createLock(context, record);
	if (lockResult === "locked") return handleLockedSetup(context);
	return spawnSetup(context, record, mode);
}

export async function cancelSetup(context: SetupContext): Promise<string> {
	const record = await finalizeRunIfNeeded(context);
	if (record?.status !== "running") return "실행 중인 setup.sh가 없습니다.";
	if (!isPidAlive(record.pid)) {
		await finalizeRunIfNeeded(context);
		return "setup.sh 프로세스가 이미 종료되었습니다.";
	}
	try {
		process.kill(-record.pid, "SIGTERM");
	} catch {
		try {
			process.kill(record.pid, "SIGTERM");
		} catch (error) {
			return `setup.sh 종료 신호 전송 실패: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return `setup.sh 종료 신호를 보냈습니다. pid=${record.pid}`;
}
