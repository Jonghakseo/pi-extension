import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownProcessStartIdentity, processLiveness } from "./process-identity.mjs";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 15_000;

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isProvablyDead(owner) {
	return processLiveness(owner.pid, owner.processIdentity) === "dead";
}

function readLockOwner(lockPath) {
	try {
		const path = lstatSync(lockPath).isDirectory() ? join(lockPath, "owner.json") : lockPath;
		const owner = JSON.parse(readFileSync(path, "utf8"));
		return Number.isInteger(owner?.pid) && typeof owner.token === "string" ? owner : undefined;
	} catch {
		return undefined;
	}
}

function markerPaths(path, token) {
	const privatePath = `${path}.${process.pid}.${token}`;
	return { privatePath, markerPath: path };
}

function acquireMarker(path) {
	const token = randomUUID();
	const { privatePath, markerPath } = markerPaths(path, token);
	writeFileSync(
		privatePath,
		`${JSON.stringify({ pid: process.pid, processIdentity: ownProcessStartIdentity(), token })}\n`,
		{
			flag: "wx",
			mode: 0o600,
		},
	);
	if (path.endsWith("jobs.lock") && process.env.PI_CRON_TEST_CRASH_AFTER_LOCK_RECORD === "1") {
		process.kill(process.pid, "SIGKILL");
	}
	try {
		linkSync(privatePath, markerPath);
		return { token, privatePath };
	} catch (error) {
		try {
			unlinkSync(privatePath);
		} catch {}
		if (error?.code === "EEXIST") return undefined;
		throw error;
	}
}

function releaseMarker(path, marker) {
	try {
		const owner = readLockOwner(path);
		if (owner?.token === marker.token) unlinkSync(path);
	} catch {}
	try {
		unlinkSync(marker.privatePath);
	} catch {}
}

function reclaimDeadMarker(path) {
	const owner = readLockOwner(path);
	if (!owner || !isProvablyDead(owner)) return false;
	try {
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

function removeLockPath(lockPath) {
	const stalePath = `${lockPath}.stale-${randomUUID()}`;
	try {
		renameSync(lockPath, stalePath);
		rmSync(stalePath, { recursive: true, force: true });
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

function reclaimDeadLock(lockPath) {
	const observed = readLockOwner(lockPath);
	if (!observed || !isProvablyDead(observed)) return;

	const reclaimPath = `${lockPath}.reclaim`;
	let reclaim = acquireMarker(reclaimPath);
	if (!reclaim && reclaimDeadMarker(reclaimPath)) reclaim = acquireMarker(reclaimPath);
	if (!reclaim) return;
	try {
		const current = readLockOwner(lockPath);
		if (!current || current.token !== observed.token || current.pid !== observed.pid || !isProvablyDead(current))
			return;
		removeLockPath(lockPath);
	} finally {
		releaseMarker(reclaimPath, reclaim);
	}
}

/** Serializes a synchronous action across extension and daemon processes for one lock path. */
export function withFileLock(lockPath, action) {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let marker;
	while (!marker) {
		marker = acquireMarker(lockPath);
		if (marker) break;
		reclaimDeadLock(lockPath);
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for cron store lock: ${lockPath}`);
		sleep(LOCK_RETRY_MS);
	}
	try {
		return action();
	} finally {
		releaseMarker(lockPath, marker);
	}
}

/** Serializes a synchronous read-modify-write transaction across extension and daemon processes. */
export function withStoreLock(cronDir, action) {
	return withFileLock(join(cronDir, "jobs.lock"), action);
}

export function writeAtomicFile(path, content, encoding = "utf8") {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, content, { encoding, mode: 0o600 });
	renameSync(tempPath, path);
}
