import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionBridge, sessionOwnerPath } from "./session-bridge.ts";
import {
	claimDelegatedSessionOwner,
	delegateOwnerPath,
	getSessionDelegatePath,
	SessionDelegateBusyError,
} from "./session-delegate.mjs";

async function request(endpoint: string, payload: unknown): Promise<Record<string, unknown>> {
	return new Promise((resolveRequest, reject) => {
		const socket = createConnection(endpoint);
		let output = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk) => {
			output += chunk;
			if (!output.includes("\n")) return;
			resolveRequest(JSON.parse(output));
			socket.end();
		});
		socket.on("error", reject);
	});
}

function writeSession(sessionFile: string, sessionId = "session-a"): void {
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`);
}

function readRecord(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("cron session delegate", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let agentDir: string;
	let sessionFile: string;

	beforeEach(() => {
		agentDir = join("/tmp", `pi-cron-delegate-${process.pid}-${Date.now()}-${Math.random()}`);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		sessionFile = join(agentDir, "sessions", "a.jsonl");
		writeSession(sessionFile);
	});

	afterEach(() => {
		delete process.env.PI_CRON_SESSION_RESERVATION;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("holds the lease the extension reads, defers every delivery, and reports it without the prompt", async () => {
		const deferred: unknown[] = [];
		const delegate = await claimDelegatedSessionOwner({
			agentDir,
			sessionId: "session-a",
			sessionFile,
			onDeferred: (delivery) => deferred.push(delivery),
		});
		try {
			expect(delegateOwnerPath(agentDir, "session-a")).toBe(sessionOwnerPath("session-a"));
			const record = readRecord(sessionOwnerPath("session-a"));
			expect(record).toMatchObject({ state: "active", pid: process.pid, endpoint: delegate.endpoint });
			const generation = record.generation;
			const answer = await request(delegate.endpoint, {
				id: "r1",
				generation,
				sessionId: "session-a",
				sessionFile,
				prompt: "secret prompt",
			});
			expect(answer).toEqual({ id: "r1", ok: false, deferred: true, error: "session owner is waking" });
			expect(deferred).toEqual([{ id: "r1" }]);
			const mismatch = await request(delegate.endpoint, {
				id: "r2",
				generation: "other",
				sessionId: "session-a",
				sessionFile,
				prompt: "x",
			});
			expect(mismatch).toMatchObject({ ok: false, error: "session identity mismatch" });
			expect(mismatch.deferred).toBeUndefined();
			expect(deferred).toHaveLength(1);
		} finally {
			await delegate.stop();
		}
		expect(existsSync(sessionOwnerPath("session-a"))).toBe(false);
		expect(existsSync(delegate.endpoint)).toBe(false);
	});

	it("never takes a live owner's lease but replaces a dead one", async () => {
		const bridge = new SessionBridge("session-a", sessionFile, { sendUserMessage() {} } as never);
		await bridge.start();
		await expect(claimDelegatedSessionOwner({ agentDir, sessionId: "session-a", sessionFile })).rejects.toBeInstanceOf(
			SessionDelegateBusyError,
		);
		await bridge.stop();

		const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
			encoding: "utf8",
		});
		const deadPid = Number(exited.stdout);
		mkdirSync(dirname(sessionOwnerPath("session-a")), { recursive: true });
		writeFileSync(
			sessionOwnerPath("session-a"),
			JSON.stringify({
				sessionId: "session-a",
				sessionFile,
				endpoint: "",
				pid: deadPid,
				generation: "g",
				state: "draining",
			}),
		);
		const delegate = await claimDelegatedSessionOwner({ agentDir, sessionId: "session-a", sessionFile });
		expect(readRecord(sessionOwnerPath("session-a"))).toMatchObject({ state: "active", pid: process.pid });
		await delegate.stop();
	});

	it("hands its lease to a successor through the extension's reservation adoption", async () => {
		const delegate = await claimDelegatedSessionOwner({ agentDir, sessionId: "session-a", sessionFile });
		process.env.PI_CRON_SESSION_RESERVATION = await delegate.reserveForSuccessor();
		expect(readRecord(sessionOwnerPath("session-a"))).toMatchObject({ state: "reserved", endpoint: "" });
		expect(existsSync(delegate.endpoint)).toBe(false);

		const delivered: string[] = [];
		const bridge = new SessionBridge("session-a", sessionFile, {
			sendUserMessage: (message: string) => delivered.push(message),
		} as never);
		await bridge.start();
		try {
			const owner = readRecord(sessionOwnerPath("session-a"));
			expect(owner.state).toBe("active");
			expect(process.env.PI_CRON_SESSION_RESERVATION).toBeUndefined();
			// A late release (the host saw the successor exit, or timed out) must not touch the adopted lease.
			expect(delegate.releaseReservation()).toBe("adopted");
			const answer = await request(owner.endpoint as string, {
				id: "r1",
				generation: owner.generation,
				sessionId: "session-a",
				sessionFile,
				prompt: "hello",
			});
			expect(answer).toMatchObject({ ok: true, outcome: "queued" });
			expect(delivered).toEqual(["hello"]);
		} finally {
			await bridge.stop();
		}
	});

	it("removes an unadopted reservation and its adoption lock so the daemon can resume the session", async () => {
		const delegate = await claimDelegatedSessionOwner({ agentDir, sessionId: "session-a", sessionFile });
		const reservation = JSON.parse(await delegate.reserveForSuccessor());
		const adoptLock = sessionOwnerPath("session-a").replace(/\.json$/, `-${reservation.generation}.adopt`);
		writeFileSync(adoptLock, "");
		expect(delegate.releaseReservation()).toBe("released");
		expect(existsSync(sessionOwnerPath("session-a"))).toBe(false);
		expect(existsSync(adoptLock)).toBe(false);
		expect(readdirSync(dirname(sessionOwnerPath("session-a"))).filter((name) => name.endsWith(".json"))).toEqual([]);
		await delegate.stop();
	});

	it("reports its own module path for hosts that load it", () => {
		expect(getSessionDelegatePath()).toMatch(/session-delegate\.mjs$/);
		expect(existsSync(getSessionDelegatePath())).toBe(true);
	});
});
