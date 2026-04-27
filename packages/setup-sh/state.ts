import { mkdir, open } from "node:fs/promises";
import { LOCK_STALE_MS } from "./constants.js";
import type { ExitRecord, LockRecord, RunRecord, SetupContext, StatePaths } from "./types.js";
import { elapsedMs, isoNow, isPidAlive, maybeUnlink, readJson, writeJsonAtomic } from "./utils.js";

export async function ensureStateDirs(
	paths: Pick<StatePaths, "rootDir" | "locksDir" | "logsDir" | "statesDir" | "exitsDir" | "wrappersDir">,
): Promise<void> {
	await Promise.all([
		mkdir(paths.rootDir, { recursive: true }),
		mkdir(paths.locksDir, { recursive: true }),
		mkdir(paths.logsDir, { recursive: true }),
		mkdir(paths.statesDir, { recursive: true }),
		mkdir(paths.exitsDir, { recursive: true }),
		mkdir(paths.wrappersDir, { recursive: true }),
	]);
}

export async function finalizeRunIfNeeded(context: SetupContext): Promise<RunRecord | null> {
	const record = await readJson<RunRecord>(context.paths.statePath);
	if (!record) {
		const lock = await readJson<LockRecord>(context.paths.lockPath);
		if (lock && isPidAlive(lock.pid)) return { ...lock, status: "running", mode: "auto" };
		if (lock) await maybeUnlink(context.paths.lockPath);
		return null;
	}
	if (record.status !== "running") return record;

	const exitRecord = await readJson<ExitRecord>(record.exitPath);
	if (exitRecord) {
		const next: RunRecord = {
			...record,
			status: exitRecord.status,
			exitCode: exitRecord.exitCode,
			finishedAt: exitRecord.finishedAt,
			message:
				exitRecord.status === "success"
					? "setup.sh completed"
					: exitRecord.status === "cancelled"
						? "setup.sh cancelled"
						: `setup.sh exited with code ${exitRecord.exitCode}`,
		};
		await writeJsonAtomic(context.paths.statePath, next);
		await maybeUnlink(context.paths.lockPath);
		return next;
	}

	const lock = await readJson<LockRecord>(context.paths.lockPath);
	if (lock && isPidAlive(lock.pid)) return record;

	const lockAge = lock ? elapsedMs(lock.startedAt) : elapsedMs(record.startedAt);
	if (!lock || lockAge > LOCK_STALE_MS || !isPidAlive(record.pid)) {
		const next: RunRecord = {
			...record,
			status: "stale",
			finishedAt: isoNow(),
			message: "setup.sh stopped without writing an exit status",
		};
		await writeJsonAtomic(context.paths.statePath, next);
		await maybeUnlink(context.paths.lockPath);
		return next;
	}

	return record;
}

export async function createLock(context: SetupContext, record: LockRecord): Promise<"acquired" | "locked"> {
	await ensureStateDirs(context.paths);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(context.paths.lockPath, "wx");
			try {
				await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf-8");
			} finally {
				await handle.close();
			}
			return "acquired";
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code !== "EEXIST") throw error;

			const existing = await readJson<LockRecord>(context.paths.lockPath);
			if (existing && isPidAlive(existing.pid)) return "locked";
			await maybeUnlink(context.paths.lockPath);
		}
	}
	return "locked";
}
