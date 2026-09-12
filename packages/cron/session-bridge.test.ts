import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownProcessStartIdentity } from "./process-identity.mjs";
import { SessionBridge, sessionOwnerPath } from "./session-bridge.ts";

async function requestRaw(endpoint: string, payload: string): Promise<Record<string, unknown>> {
	return new Promise((resolveRequest, reject) => {
		const socket = createConnection(endpoint);
		let output = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(payload));
		socket.on("data", (chunk) => {
			output += chunk;
			if (!output.includes("\n")) return;
			resolveRequest(JSON.parse(output));
			socket.end();
		});
		socket.on("error", reject);
	});
}

async function request(endpoint: string, payload: unknown): Promise<Record<string, unknown>> {
	return requestRaw(endpoint, `${JSON.stringify(payload)}\n`);
}

function writeSession(sessionFile: string, sessionId = "session-a"): void {
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`);
}

describe("cron session bridge", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let agentDir: string;

	beforeEach(() => {
		agentDir = join("/tmp", `pi-cron-bridge-${process.pid}-${Date.now()}-${Math.random()}`);
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("queues only correlated requests once for its persisted session and cleans up on shutdown", async () => {
		const pi = { sendUserMessage: vi.fn() };
		const sessionFile = join(agentDir, "source.jsonl");
		writeSession(sessionFile);
		const bridge = new SessionBridge("session-a", sessionFile, pi as never);
		await bridge.start();

		const owner = JSON.parse(readFileSync(sessionOwnerPath("session-a"), "utf8"));
		const payload = {
			id: "job-1",
			generation: owner.generation,
			sessionId: "session-a",
			sessionFile,
			prompt: "resume this work",
		};
		const accepted = await request(owner.endpoint, payload);
		expect(accepted).toMatchObject({ id: "job-1", ok: true, outcome: "queued" });
		await request(owner.endpoint, payload);
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

		const rejected = await request(owner.endpoint, { ...payload, id: "job-2", sessionId: "other-session" });
		expect(rejected).toMatchObject({ ok: false, error: "session identity mismatch" });
		await bridge.stop();
		expect(existsSync(sessionOwnerPath("session-a"))).toBe(false);
	});

	it("defers host-paused delivery before sending any Pi follow-up", async () => {
		const pi = { sendUserMessage: vi.fn() };
		const sessionFile = join(agentDir, "source.jsonl");
		writeSession(sessionFile);
		let paused = true;
		const bridge = new SessionBridge("session-a", sessionFile, pi as never, { isDeliveryPaused: () => paused });
		await bridge.start();
		try {
			const owner = JSON.parse(readFileSync(sessionOwnerPath("session-a"), "utf8"));
			const payload = { ...owner, id: "paused-job", prompt: "scheduled work" };

			expect(await request(owner.endpoint, payload)).toMatchObject({
				id: "paused-job",
				ok: false,
				deferred: true,
				error: "host delivery paused",
			});
			expect(pi.sendUserMessage).not.toHaveBeenCalled();

			paused = false;
			expect(await request(owner.endpoint, payload)).toMatchObject({ id: "paused-job", ok: true, outcome: "queued" });
			expect(pi.sendUserMessage).toHaveBeenCalledWith("scheduled work", {
				deliverAs: "followUp",
				expandPromptTemplates: true,
			});
		} finally {
			await bridge.stop();
		}
	});

	it("consumes the RPC reservation so the same session can reload and reattach", async () => {
		const previousReservation = process.env.PI_CRON_SESSION_RESERVATION;
		const sessionFile = join(agentDir, "source.jsonl");
		writeSession(sessionFile);
		const registryPath = sessionOwnerPath("session-a");
		mkdirSync(dirname(registryPath), { recursive: true });
		const reservation = {
			sessionId: "session-a",
			sessionFile: realpathSync(sessionFile),
			endpoint: "",
			pid: process.pid,
			generation: randomUUID(),
			state: "reserved",
		};
		writeFileSync(registryPath, JSON.stringify(reservation));
		process.env.PI_CRON_SESSION_RESERVATION = JSON.stringify(reservation);
		const pi = { sendUserMessage: vi.fn() };
		const initial = new SessionBridge("session-a", sessionFile, pi as never);
		const reloaded = new SessionBridge("session-a", sessionFile, pi as never);
		try {
			await initial.start();
			await initial.stop();
			await reloaded.start();
			const owner = JSON.parse(readFileSync(registryPath, "utf8"));
			expect(await request(owner.endpoint, { ...owner, id: "after-reload", prompt: "Continue" })).toMatchObject({
				ok: true,
			});
			expect(pi.sendUserMessage).toHaveBeenCalledWith("Continue", {
				deliverAs: "followUp",
				expandPromptTemplates: true,
			});
		} finally {
			await initial.stop();
			await reloaded.stop();
			if (previousReservation === undefined) delete process.env.PI_CRON_SESSION_RESERVATION;
			else process.env.PI_CRON_SESSION_RESERVATION = previousReservation;
		}
	});

	it("reclaims only a verified dead owner", async () => {
		const pi = { sendUserMessage: vi.fn() };
		const sessionFile = join(agentDir, "source.jsonl");
		writeSession(sessionFile);
		const registryPath = sessionOwnerPath("session-a");
		mkdirSync(dirname(registryPath), { recursive: true });
		writeFileSync(
			registryPath,
			JSON.stringify({
				sessionId: "session-a",
				sessionFile,
				endpoint: join(agentDir, "old.sock"),
				pid: 999_999,
				generation: "dead-owner",
				state: "active",
			}),
		);
		const bridge = new SessionBridge("session-a", sessionFile, pi as never);
		await bridge.start();
		expect(JSON.parse(readFileSync(registryPath, "utf8"))).not.toMatchObject({ generation: "dead-owner" });
		await bridge.stop();
	});

	it("publishes an active owner only after the delivery endpoint is ready", async () => {
		const pi = { sendUserMessage: vi.fn() };
		const sessionFile = join(agentDir, "source.jsonl");
		writeSession(sessionFile);
		const bridge = new SessionBridge("session-a", sessionFile, pi as never);
		const started = bridge.start();
		try {
			const path = sessionOwnerPath("session-a");
			const beforeReady = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
			expect(beforeReady?.state).not.toBe("active");
			await started;
			const owner = JSON.parse(readFileSync(path, "utf8"));
			expect(owner.state).toBe("active");
			expect(await request(owner.endpoint, { ...owner, id: "ready-job", prompt: "ready" })).toMatchObject({
				ok: true,
				outcome: "queued",
			});
			expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		} finally {
			await started.catch(() => {});
			await bridge.stop();
		}
	});

	it("does not overwrite an owner whose process identity cannot be validated", async () => {
		const sessionFile = join(agentDir, "source.jsonl");
		writeSession(sessionFile);
		const path = sessionOwnerPath("session-a");
		mkdirSync(dirname(path), { recursive: true });
		for (const record of ["{", JSON.stringify({ pid: -1, generation: "unknown-owner" })]) {
			writeFileSync(path, record);
			const bridge = new SessionBridge("session-a", sessionFile, { sendUserMessage: vi.fn() } as never);
			await expect(bridge.start()).rejects.toThrow();
			expect(readFileSync(path, "utf8")).toBe(record);
		}
	});

	it("keeps a draining owner until an authorized successor replaces it", async () => {
		const pi = { sendUserMessage: vi.fn() };
		const sessionFile = join(agentDir, "source.jsonl");
		writeSession(sessionFile);
		const first = new SessionBridge("session-a", sessionFile, pi as never);
		await first.start();
		await first.beginDraining();
		const draining = JSON.parse(readFileSync(sessionOwnerPath("session-a"), "utf8"));
		expect(draining.state).toBe("draining");
		await expect(new SessionBridge("session-a", sessionFile, pi as never).start()).rejects.toThrow("already holds");

		const successor = new SessionBridge("session-a", sessionFile, pi as never, { allowDrainingHandoff: true });
		await successor.start();
		const replacement = JSON.parse(readFileSync(sessionOwnerPath("session-a"), "utf8"));
		expect(replacement).toMatchObject({ state: "active" });
		await first.stop();
		expect(JSON.parse(readFileSync(sessionOwnerPath("session-a"), "utf8"))).toMatchObject({
			generation: replacement.generation,
		});
		await successor.stop();
	});

	it("reclaims a recycled PID identity but never steals a matching or unknown live owner", async () => {
		const pi = { sendUserMessage: vi.fn() };
		const sessionFile = join(agentDir, "source.jsonl");
		writeSession(sessionFile);
		const registryPath = sessionOwnerPath("session-a");
		mkdirSync(dirname(registryPath), { recursive: true });
		const liveOwner = {
			sessionId: "session-a",
			sessionFile: realpathSync(sessionFile),
			endpoint: join(agentDir, "old.sock"),
			pid: process.pid,
			generation: "old-owner",
			state: "active",
		};
		writeFileSync(registryPath, JSON.stringify({ ...liveOwner, processIdentity: "recycled-pid" }));
		const reclaimed = new SessionBridge("session-a", sessionFile, pi as never);
		await reclaimed.start();
		await reclaimed.stop();

		writeFileSync(registryPath, JSON.stringify({ ...liveOwner, processIdentity: ownProcessStartIdentity() }));
		await expect(new SessionBridge("session-a", sessionFile, pi as never).start()).rejects.toThrow("already holds");
		unlinkSync(registryPath);
		writeFileSync(registryPath, JSON.stringify(liveOwner));
		await expect(new SessionBridge("session-a", sessionFile, pi as never).start()).rejects.toThrow("already holds");
	});

	it("does not allow same-PID replacement, accepts malformed frames safely, and leaves a replacement owner intact", async () => {
		const pi = { sendUserMessage: vi.fn() };
		const sessionFile = join(agentDir, "source.jsonl");
		writeSession(sessionFile);
		const first = new SessionBridge("session-a", sessionFile, pi as never);
		await first.start();
		const duplicate = new SessionBridge("session-a", sessionFile, pi as never);
		await expect(duplicate.start()).rejects.toThrow("already holds");
		const firstOwner = JSON.parse(readFileSync(sessionOwnerPath("session-a"), "utf8"));
		const malformed = await request(firstOwner.endpoint, null);
		expect(malformed).toMatchObject({ ok: false, error: "invalid request" });
		const oversized = await requestRaw(firstOwner.endpoint, "x".repeat(64 * 1024 + 1));
		expect(oversized).toMatchObject({ ok: false, error: "request too large" });

		await first.stop();
		const replacement = new SessionBridge("session-a", sessionFile, pi as never);
		await replacement.start();
		const replacementOwner = JSON.parse(readFileSync(sessionOwnerPath("session-a"), "utf8"));
		await first.stop();
		expect(JSON.parse(readFileSync(sessionOwnerPath("session-a"), "utf8"))).toMatchObject({
			generation: replacementOwner.generation,
		});
		await replacement.stop();
	});
});
