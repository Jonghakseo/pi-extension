import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownProcessStartIdentity, processLiveness } from "./process-identity.mjs";
import { writeAtomicFile } from "./store-lock.mjs";

export const DAEMON_PROTOCOL_VERSION = 1;

export function getDaemonPath() {
	return join(dirname(fileURLToPath(import.meta.url)), "daemon.mjs");
}

export function daemonRuntimeId(daemonPath = getDaemonPath()) {
	const runtimeDir = dirname(daemonPath);
	const hash = createHash("sha256");
	for (const file of ["daemon.mjs", "daemon-runtime.mjs", "process-identity.mjs", "store-lock.mjs"]) {
		hash.update(file);
		hash.update("\0");
		hash.update(readFileSync(join(runtimeDir, file)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function daemonOwnerPath(cronDir) {
	return join(cronDir, "daemon.runtime.json");
}

export function readDaemonOwner(cronDir) {
	try {
		const owner = JSON.parse(readFileSync(daemonOwnerPath(cronDir), "utf8"));
		if (
			!Number.isInteger(owner?.pid) ||
			typeof owner.processIdentity !== "string" ||
			typeof owner.runtimeId !== "string" ||
			owner.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
			typeof owner.daemonPath !== "string" ||
			(owner.drainTimeoutMs !== undefined && (!Number.isFinite(owner.drainTimeoutMs) || owner.drainTimeoutMs <= 0))
		)
			return undefined;
		return owner;
	} catch {
		return undefined;
	}
}

export function daemonOwnerLiveness(owner) {
	if (!owner) return "unknown";
	return processLiveness(owner.pid, owner.processIdentity);
}

export function writeDaemonOwner(cronDir, daemonPath = getDaemonPath(), options = {}) {
	const owner = {
		pid: process.pid,
		processIdentity: ownProcessStartIdentity(),
		runtimeId: daemonRuntimeId(daemonPath),
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		daemonPath,
		drainTimeoutMs: options.drainTimeoutMs,
	};
	if (!owner.processIdentity) throw new Error("cannot prove daemon process start identity");
	writeAtomicFile(daemonOwnerPath(cronDir), `${JSON.stringify(owner)}\n`);
	return owner;
}

export function removeDaemonOwner(cronDir, expectedPid = process.pid, expectedIdentity = ownProcessStartIdentity()) {
	const path = daemonOwnerPath(cronDir);
	const owner = readDaemonOwner(cronDir);
	if (!owner || owner.pid !== expectedPid || owner.processIdentity !== expectedIdentity) return;
	try {
		unlinkSync(path);
	} catch {}
}

export function daemonOwnerExists(cronDir) {
	return existsSync(daemonOwnerPath(cronDir));
}
