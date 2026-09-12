import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

let ownIdentity;

function linuxIdentity(pid) {
	try {
		const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		const fields = stat
			.slice(closeParen + 2)
			.trim()
			.split(/\s+/);
		const startTime = fields[19]; // proc(5): field 22, after pid and comm.
		return bootId && startTime ? `linux:${bootId}:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

function macIdentity(pid) {
	try {
		const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: "C" },
			timeout: 1000,
		});
		const started = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
		return started ? `darwin:${started}` : undefined;
	} catch {
		return undefined;
	}
}

/** Returns a stable identity for a live process, or undefined when the platform cannot prove one. */
export function processStartIdentity(pid) {
	if (!Number.isInteger(pid) || pid < 1) return undefined;
	if (platform() === "linux") return linuxIdentity(pid);
	if (platform() === "darwin") return macIdentity(pid);
	return undefined;
}

/** Caches only this process's identity. Other processes are always re-read to detect PID reuse. */
export function ownProcessStartIdentity() {
	if (ownIdentity === undefined) ownIdentity = processStartIdentity(process.pid) || null;
	return ownIdentity || undefined;
}

/**
 * `dead` is only returned for ESRCH or a mismatched recorded start identity.
 * Missing identity data is deliberately `unknown`, so callers never steal a live lease on uncertainty.
 */
export function processLiveness(pid, expectedIdentity) {
	if (!Number.isInteger(pid) || pid < 1) return "unknown";
	try {
		process.kill(pid, 0);
	} catch (error) {
		return error?.code === "ESRCH" ? "dead" : "unknown";
	}
	if (typeof expectedIdentity !== "string" || !expectedIdentity) return "unknown";
	const actualIdentity = processStartIdentity(pid);
	if (!actualIdentity) return "unknown";
	return actualIdentity === expectedIdentity ? "alive" : "dead";
}
