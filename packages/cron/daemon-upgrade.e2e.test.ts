import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonRuntimeId, readDaemonOwner } from "./daemon-runtime.mjs";
import type { CronJob, CronStoreFile } from "./types.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));
const daemonPath = resolve(packageDir, "daemon.mjs");
const coordinatorPath = resolve(packageDir, "upgrade-coordinator.mjs");

let agentDir: string;
const children: ChildProcess[] = [];

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last = read();
	while (Date.now() < deadline) {
		last = read();
		if (predicate(last)) return last;
		await sleep(25);
	}
	throw new Error(`Timed out waiting for condition: ${JSON.stringify(last)}`);
}

function owner() {
	return readDaemonOwner(join(agentDir, "cron"));
}

function readStore(): CronStoreFile {
	return JSON.parse(readFileSync(join(agentDir, "cron", "jobs.json"), "utf8"));
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function start(path: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
	const child = spawn(process.execPath, [path], {
		cwd: agentDir,
		stdio: "ignore",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CRON_TICK_INTERVAL_MS: "20",
			PI_CRON_RETRY_LOCK_INTERVAL_MS: "20",
			PI_CRON_UPGRADE_TIMEOUT_MS: "4000",
			PI_CRON_UPGRADE_POLL_MS: "20",
			...env,
		},
	});
	children.push(child);
	return child;
}

async function stop(child: ChildProcess | undefined): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveStop) => {
		const force = setTimeout(() => child.kill("SIGKILL"), 500);
		child.once("close", () => {
			clearTimeout(force);
			resolveStop();
		});
		child.kill("SIGTERM");
	});
}

function writeStore(jobs: CronJob[]): void {
	const root = join(agentDir, "cron");
	mkdirSync(join(root, "prompts"), { recursive: true });
	for (const job of jobs) writeFileSync(job.promptFile, "upgrade test prompt\n");
	writeFileSync(join(root, "jobs.json"), `${JSON.stringify({ version: 2, jobs, history: [] })}\n`);
}

function job(id: string, runAt = new Date(Date.now() - 1000).toISOString()): CronJob {
	const now = new Date().toISOString();
	return {
		id,
		name: id,
		enabled: true,
		kind: "at",
		once: true,
		runAt,
		nextRunAt: runAt,
		timezone: "UTC",
		cwd: agentDir,
		promptFile: join(agentDir, "cron", "prompts", `${id}.md`),
		createdAt: now,
		updatedAt: now,
	};
}

function markOutdated(): { pid: number } {
	const current = owner();
	if (!current) throw new Error("daemon owner missing");
	writeFileSync(
		join(agentDir, "cron", "daemon.runtime.json"),
		`${JSON.stringify({ ...current, runtimeId: "outdated" })}\n`,
	);
	return { pid: current.pid };
}

describe("cron daemon automatic upgrade", () => {
	beforeEach(() => {
		agentDir = join(tmpdir(), `pi-cron-upgrade-${process.pid}-${Date.now()}-${Math.random()}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		for (const child of children.splice(0).reverse()) await stop(child);
		const current = owner();
		if (current && isAlive(current.pid)) {
			try {
				process.kill(current.pid, "SIGTERM");
			} catch {}
		}
		await sleep(50);
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("does nothing for a matching runtime, and concurrent coordinators replace an outdated manual daemon once", async () => {
		const old = start(daemonPath);
		const initial = await waitFor(owner, Boolean);
		if (!initial) throw new Error("daemon owner missing");
		start(coordinatorPath);
		await sleep(150);
		expect(owner()?.pid).toBe(initial.pid);

		const { pid: oldPid } = markOutdated();
		start(coordinatorPath);
		start(coordinatorPath);
		const replacement = await waitFor(owner, (value) => Boolean(value && value.pid !== oldPid));
		expect(replacement?.runtimeId).toBe(daemonRuntimeId());
		expect(isAlive(oldPid)).toBe(false);
		const upgradeLog = await waitFor(
			() => readFileSync(join(agentDir, "cron", "daemon.log"), "utf8"),
			(value) => value.includes("manual daemon replaced"),
		);
		expect(upgradeLog.match(/manual daemon replaced/g)).toHaveLength(1);
		await stop(old);
	});

	it("drains a gated job before replacement and claims no newly due work after the drain begins", async () => {
		const release = join(agentDir, "release");
		const started = join(agentDir, "started");
		const fakePi = join(agentDir, "fake-pi.sh");
		writeFileSync(
			fakePi,
			`#!/bin/sh\ntouch ${JSON.stringify(started)}\nwhile [ ! -f ${JSON.stringify(release)} ]; do sleep 0.01; done\n`,
			{ mode: 0o755 },
		);
		writeStore([job("gated")]);
		const old = start(daemonPath, { PI_CRON_PI_BIN: fakePi });
		await waitFor(() => existsSync(started), Boolean);
		const { pid: oldPid } = markOutdated();
		start(coordinatorPath, { PI_CRON_PI_BIN: fakePi });
		await waitFor(
			() =>
				existsSync(join(agentDir, "cron", "daemon.log"))
					? readFileSync(join(agentDir, "cron", "daemon.log"), "utf8")
					: "",
			(value) => value.includes("upgrade drain requested"),
		);
		expect(isAlive(oldPid)).toBe(true);

		const afterDrain = job("after-drain");
		writeStore([...readStore().jobs, afterDrain]);
		await sleep(150);
		expect(readStore().jobs.find((candidate) => candidate.id === "after-drain")?.running).not.toBe(true);
		writeStore(
			readStore().jobs.map((candidate) =>
				candidate.id === "after-drain" ? { ...candidate, enabled: false } : candidate,
			),
		);

		writeFileSync(release, "go");
		const replacement = await waitFor(owner, (value) => Boolean(value && value.pid !== oldPid));
		expect(replacement?.runtimeId).toBe(daemonRuntimeId());
		expect(isAlive(oldPid)).toBe(false);
		await stop(old);
	});

	it("does not kill a legacy daemon while its direct child is running, then replaces it after the child exits", async () => {
		const release = join(agentDir, "release-legacy-child");
		const childScript = join(agentDir, "legacy-child.mjs");
		const childStarted = join(agentDir, "legacy-child-started");
		const legacy = join(agentDir, "legacy-daemon.mjs");
		writeFileSync(
			childScript,
			`import { existsSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(childStarted)}, "started"); while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));`,
		);
		writeFileSync(
			legacy,
			`import { mkdirSync, writeFileSync } from "node:fs"; import { spawn } from "node:child_process"; import { join } from "node:path"; const cron = join(process.env.PI_CODING_AGENT_DIR, "cron"); mkdirSync(cron, { recursive: true }); writeFileSync(join(cron, "daemon.pid"), String(process.pid)); spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
		);
		const old = start(legacy);
		const oldPid = await waitFor(
			() =>
				existsSync(join(agentDir, "cron", "daemon.pid"))
					? Number(readFileSync(join(agentDir, "cron", "daemon.pid"), "utf8"))
					: undefined,
			(value) => Boolean(value),
		);
		if (!oldPid) throw new Error("legacy daemon pid missing");
		await waitFor(() => existsSync(childStarted), Boolean);
		start(coordinatorPath, { PI_CRON_TEST_LEGACY_DAEMON_PATH: legacy });
		await sleep(200);
		expect(isAlive(oldPid)).toBe(true);
		expect(owner()).toBeUndefined();

		writeFileSync(release, "go");
		const replacement = await waitFor(owner, Boolean);
		expect(replacement?.runtimeId).toBe(daemonRuntimeId());
		expect(isAlive(oldPid)).toBe(false);
		await stop(old);
	});

	it("kickstarts launchd only after the outdated daemon exits", async () => {
		const launchctlLog = join(agentDir, "launchctl.log");
		const launchctl = join(agentDir, "fake-launchctl.sh");
		writeFileSync(
			launchctl,
			`#!/bin/sh\necho "$@" >> ${JSON.stringify(launchctlLog)}\nif [ "$1" = "kickstart" ]; then\n  ${JSON.stringify(process.execPath)} ${JSON.stringify(daemonPath)} >/dev/null 2>&1 &\nfi\n`,
			{ mode: 0o755 },
		);
		const old = start(daemonPath);
		const initial = await waitFor(owner, Boolean);
		if (!initial) throw new Error("daemon owner missing");
		const { pid: oldPid } = markOutdated();
		start(coordinatorPath, {
			PI_CRON_UPGRADE_LAUNCHD: "1",
			PI_CRON_UPGRADE_LAUNCHD_GRACE_MS: "50",
			PI_CRON_LAUNCHCTL_BIN: launchctl,
		});
		const replacement = await waitFor(owner, (value) => Boolean(value && value.pid !== oldPid));
		expect(replacement?.runtimeId).toBe(daemonRuntimeId());
		expect(isAlive(oldPid)).toBe(false);
		expect(readFileSync(launchctlLog, "utf8")).toMatch(/^kickstart gui\/\d+\/dev\.pi\.cron/m);
		await stop(old);
	});

	it("does not treat an unrelated live PID as a legacy daemon", async () => {
		const unrelated = join(agentDir, "unrelated.mjs");
		writeFileSync(unrelated, "setInterval(() => {}, 1000);");
		const other = start(unrelated);
		if (!other.pid) throw new Error("unrelated process pid missing");
		mkdirSync(join(agentDir, "cron"), { recursive: true });
		writeFileSync(join(agentDir, "cron", "daemon.pid"), String(other.pid));

		start(coordinatorPath);
		await sleep(150);
		expect(isAlive(other.pid)).toBe(true);
		expect(owner()).toBeUndefined();
		await stop(other);
	});

	it("does not treat a stale runtime record as an unverified legacy PID", async () => {
		const unrelated = join(agentDir, "unrelated.mjs");
		writeFileSync(unrelated, "setInterval(() => {}, 1000);");
		const other = start(unrelated);
		if (!other.pid) throw new Error("unrelated process pid missing");
		mkdirSync(join(agentDir, "cron"), { recursive: true });
		writeFileSync(join(agentDir, "cron", "daemon.pid"), String(other.pid));
		writeFileSync(
			join(agentDir, "cron", "daemon.runtime.json"),
			`${JSON.stringify({
				pid: other.pid,
				processIdentity: "recycled-process",
				runtimeId: "outdated",
				protocolVersion: 1,
				daemonPath,
			})}\n`,
		);

		start(coordinatorPath);
		await sleep(150);
		expect(isAlive(other.pid)).toBe(true);
		expect(owner()?.runtimeId).toBe("outdated");
		await stop(other);
	});

	it("leaves a stopped daemon stopped without installing launchd", async () => {
		start(coordinatorPath, { PI_CRON_UPGRADE_LAUNCHD: "0" });
		await sleep(150);
		expect(existsSync(join(agentDir, "cron", "daemon.pid"))).toBe(false);
		expect(existsSync(join(agentDir, "cron", "daemon.runtime.json"))).toBe(false);
	});
});
