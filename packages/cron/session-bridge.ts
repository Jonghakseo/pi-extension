import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ownProcessStartIdentity, processLiveness } from "./process-identity.mjs";
import { ensureCronDirs, getSessionRegistryDir } from "./store.ts";
import { withFileLock, writeAtomicFile } from "./store-lock.mjs";

const MAX_FRAME_BYTES = 64 * 1024;
const READ_DEADLINE_MS = 10_000;
const MAX_REPLAY_ENTRIES = 256;

export type SessionOwnerState = "reserved" | "starting" | "active" | "draining";

export class SessionOwnerConflictError extends Error {
	constructor() {
		super("an active cron session owner already holds this session");
		this.name = "SessionOwnerConflictError";
	}
}

export interface SessionOwner {
	sessionId: string;
	sessionFile: string;
	endpoint: string;
	pid: number;
	processIdentity?: string;
	generation: string;
	state: SessionOwnerState;
}

interface SessionReservation {
	sessionId: string;
	sessionFile: string;
	generation: string;
	pid: number;
	processIdentity?: string;
}

interface DeliveryRequest {
	id?: string;
	generation?: string;
	sessionId?: string;
	sessionFile?: string;
	prompt?: string;
}

export interface SessionBridgeOptions {
	/** Only a documented session_start replacement may claim a same-process draining lease. */
	allowDrainingHandoff?: boolean;
	/** Host-owned PTT barrier. A paused host must defer before it queues Pi input. */
	isDeliveryPaused?: () => boolean;
}

function sessionKey(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

export function canonicalSessionFile(sessionFile: string): string {
	return realpathSync(sessionFile);
}

export function validatePersistedSessionFile(sessionId: string, sessionFile: string): string {
	const canonical = canonicalSessionFile(sessionFile);
	const header = readFileSync(canonical, "utf8").split("\n", 1)[0];
	let parsed: unknown;
	try {
		parsed = JSON.parse(header);
	} catch {
		throw new Error("session file has an invalid Pi session header");
	}
	if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "session") {
		throw new Error("session file has an invalid Pi session header");
	}
	if ((parsed as { id?: unknown }).id !== sessionId) {
		throw new Error("session file does not belong to the persisted session");
	}
	return canonical;
}

export function sessionOwnerPath(sessionId: string): string {
	return join(getSessionRegistryDir(), `${sessionKey(sessionId)}.json`);
}

function sessionOwnerLockPath(sessionId: string): string {
	return join(getSessionRegistryDir(), `${sessionKey(sessionId)}.lock`);
}

export function sessionEndpoint(sessionId: string, generation: string): string {
	return join(tmpdir(), `pc-${sessionKey(sessionId)}-${generation.slice(0, 8)}.sock`);
}

function adoptionLockPath(sessionId: string, generation: string): string {
	return join(getSessionRegistryDir(), `${sessionKey(sessionId)}-${generation}.adopt`);
}

function withOwnerLock<T>(sessionId: string, action: () => T): T {
	return withFileLock(sessionOwnerLockPath(sessionId), action);
}

function readOwner(path: string): SessionOwner | undefined {
	try {
		const owner = JSON.parse(readFileSync(path, "utf8")) as SessionOwner;
		return owner && typeof owner === "object" ? owner : undefined;
	} catch {
		return undefined;
	}
}

function ownerMatches(
	owner: SessionOwner,
	expected: Pick<SessionOwner, "generation" | "pid" | "endpoint" | "processIdentity">,
): boolean {
	return (
		owner.generation === expected.generation &&
		owner.pid === expected.pid &&
		owner.endpoint === expected.endpoint &&
		owner.processIdentity === expected.processIdentity
	);
}

function writeOwner(path: string, owner: SessionOwner): void {
	writeAtomicFile(path, `${JSON.stringify(owner)}\n`);
}

function unlinkIfOwned(
	path: string,
	expected: Pick<SessionOwner, "generation" | "pid" | "endpoint" | "processIdentity">,
): void {
	const current = readOwner(path);
	if (current && ownerMatches(current, expected)) unlinkSync(path);
}

function removeSocket(path: string): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {}
}

function ownerIsProvablyDead(owner: SessionOwner): boolean {
	return processLiveness(owner.pid, owner.processIdentity) === "dead";
}

function isReservation(value: unknown): value is SessionReservation {
	if (!value || typeof value !== "object") return false;
	const owner = value as Partial<SessionOwner>;
	return (
		typeof owner.sessionId === "string" &&
		typeof owner.sessionFile === "string" &&
		typeof owner.generation === "string" &&
		Number.isInteger(owner.pid) &&
		(owner.processIdentity === undefined || typeof owner.processIdentity === "string")
	);
}

function sameReservation(owner: SessionOwner, reservation: SessionReservation): boolean {
	return (
		owner.state === "reserved" &&
		owner.sessionId === reservation.sessionId &&
		owner.sessionFile === reservation.sessionFile &&
		owner.generation === reservation.generation &&
		owner.pid === reservation.pid &&
		owner.processIdentity === reservation.processIdentity
	);
}

function readReservationFromEnvironment(): SessionReservation | undefined {
	const raw = process.env.PI_CRON_SESSION_RESERVATION;
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as unknown;
		if (!isReservation(value)) return undefined;
		return { ...value, sessionFile: canonicalSessionFile(value.sessionFile) };
	} catch {
		return undefined;
	}
}

/** Releases a drained predecessor only after Pi's documented successor session_start event. */
export function releaseDrainingSessionOwner(sessionId: string, sessionFile: string): void {
	const canonical = canonicalSessionFile(sessionFile);
	const identity = ownProcessStartIdentity();
	withOwnerLock(sessionId, () => {
		const path = sessionOwnerPath(sessionId);
		const owner = readOwner(path);
		if (
			owner?.state === "draining" &&
			owner.sessionFile === canonical &&
			owner.pid === process.pid &&
			owner.processIdentity === identity
		) {
			unlinkIfOwned(path, owner);
		}
	});
}

export class SessionBridge {
	private server: Server | undefined;
	private readonly owner: SessionOwner;
	private readonly sockets = new Set<Socket>();
	private readonly replay = new Map<string, string>();
	private adoptionLock: string | undefined;

	constructor(
		sessionId: string,
		sessionFile: string,
		private readonly pi: Pick<ExtensionAPI, "sendUserMessage">,
		private readonly options: SessionBridgeOptions = {},
	) {
		const generation = randomUUID();
		this.owner = {
			sessionId,
			sessionFile: canonicalSessionFile(sessionFile),
			endpoint: sessionEndpoint(sessionId, generation),
			pid: process.pid,
			processIdentity: ownProcessStartIdentity(),
			generation,
			state: "starting",
		};
	}

	private reserveRegistry(): void {
		const registryPath = sessionOwnerPath(this.owner.sessionId);
		const reservation = readReservationFromEnvironment();
		withOwnerLock(this.owner.sessionId, () => {
			if (reservation) {
				if (reservation.sessionId !== this.owner.sessionId || reservation.sessionFile !== this.owner.sessionFile) {
					throw new Error("cron reservation does not match this session");
				}
				const lockPath = adoptionLockPath(this.owner.sessionId, reservation.generation);
				let fd: number;
				try {
					fd = openSync(lockPath, "wx", 0o600);
				} catch {
					throw new Error("a cron RPC child already adopted this session reservation");
				}
				closeSync(fd);
				this.adoptionLock = lockPath;
				const current = readOwner(registryPath);
				if (!current || !sameReservation(current, reservation)) {
					removeSocket(lockPath);
					this.adoptionLock = undefined;
					throw new Error("cron reservation was replaced before adoption");
				}
				this.owner.generation = reservation.generation;
				this.owner.endpoint = sessionEndpoint(this.owner.sessionId, reservation.generation);
				writeOwner(registryPath, this.owner);
				// The bootstrap capability is single-use, not inherited by reloads or child sessions.
				delete process.env.PI_CRON_SESSION_RESERVATION;
				return;
			}

			const existing = readOwner(registryPath);
			if (existsSync(registryPath) && !existing) throw new Error("invalid cron session owner record");
			if (existing) {
				if (ownerIsProvablyDead(existing)) {
					unlinkIfOwned(registryPath, existing);
				} else if (
					this.options.allowDrainingHandoff &&
					existing.state === "draining" &&
					existing.sessionFile === this.owner.sessionFile &&
					existing.pid === this.owner.pid &&
					existing.processIdentity === this.owner.processIdentity
				) {
					unlinkIfOwned(registryPath, existing);
				} else {
					throw new SessionOwnerConflictError();
				}
			}
			writeOwner(registryPath, this.owner);
		});
	}

	private markActive(): void {
		withOwnerLock(this.owner.sessionId, () => {
			const path = sessionOwnerPath(this.owner.sessionId);
			const current = readOwner(path);
			if (!current || !ownerMatches(current, this.owner) || current.state !== "starting") {
				throw new Error("cron session ownership changed before bridge became ready");
			}
			this.owner.state = "active";
			writeOwner(path, this.owner);
		});
	}

	private remember(id: string, response: string): void {
		this.replay.set(id, response);
		if (this.replay.size > MAX_REPLAY_ENTRIES) this.replay.delete(this.replay.keys().next().value as string);
	}

	start(): Promise<void> {
		ensureCronDirs();
		try {
			this.reserveRegistry();
		} catch (error) {
			return Promise.reject(error);
		}
		this.server = createServer((socket) => this.handleSocket(socket));
		return new Promise((resolveStart, reject) => {
			const fail = (error: Error) => {
				this.server?.removeListener("error", fail);
				this.beginDraining().then(() => reject(error), reject);
			};
			this.server?.once("error", fail);
			this.server?.listen(this.owner.endpoint, () => {
				this.server?.removeListener("error", fail);
				try {
					chmodSync(this.owner.endpoint, 0o600);
					this.markActive();
					resolveStart();
				} catch (error) {
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			});
		});
	}

	private handleSocket(socket: Socket): void {
		this.sockets.add(socket);
		let input = "";
		let handled = false;
		const deadline = setTimeout(() => socket.destroy(), READ_DEADLINE_MS);
		const close = () => {
			clearTimeout(deadline);
			this.sockets.delete(socket);
		};
		socket.setEncoding("utf8");
		socket.on("close", close);
		socket.on("error", () => socket.destroy());
		socket.on("data", (chunk: string) => {
			if (handled) return;
			input += chunk;
			if (Buffer.byteLength(input) > MAX_FRAME_BYTES) {
				handled = true;
				socket.end('{"ok":false,"error":"request too large"}\n');
				return;
			}
			const newline = input.indexOf("\n");
			if (newline === -1) return;
			handled = true;
			let request: DeliveryRequest;
			try {
				const parsed: unknown = JSON.parse(input.slice(0, newline));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid request");
				request = parsed as DeliveryRequest;
			} catch {
				socket.end('{"ok":false,"error":"invalid request"}\n');
				return;
			}
			if (
				typeof request.id !== "string" ||
				typeof request.prompt !== "string" ||
				request.generation !== this.owner.generation ||
				request.sessionId !== this.owner.sessionId ||
				typeof request.sessionFile !== "string"
			) {
				socket.end('{"ok":false,"error":"session identity mismatch"}\n');
				return;
			}
			try {
				if (canonicalSessionFile(request.sessionFile) !== this.owner.sessionFile) {
					socket.end('{"ok":false,"error":"session identity mismatch"}\n');
					return;
				}
			} catch {
				socket.end('{"ok":false,"error":"session identity mismatch"}\n');
				return;
			}
			const replay = this.replay.get(request.id);
			if (replay) {
				socket.end(replay);
				return;
			}
			if (this.owner.state !== "active") {
				socket.end(
					`${JSON.stringify({ id: request.id, ok: false, deferred: true, error: "session is transitioning" })}\n`,
				);
				return;
			}
			// The host can interrupt a voice turn while this bridge is still active.
			// Do not accept delivery into that hidden transition window.
			if (this.options.isDeliveryPaused?.()) {
				socket.end(`${JSON.stringify({ id: request.id, ok: false, deferred: true, error: "host delivery paused" })}\n`);
				return;
			}
			try {
				this.pi.sendUserMessage(request.prompt, { deliverAs: "followUp", expandPromptTemplates: true });
				const response = `${JSON.stringify({ id: request.id, ok: true, outcome: "queued" })}\n`;
				this.remember(request.id, response);
				socket.end(response);
			} catch (error) {
				const response = `${JSON.stringify({ id: request.id, ok: false, error: String(error) })}\n`;
				this.remember(request.id, response);
				socket.end(response);
			}
		});
	}

	private closeServer(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		removeSocket(this.owner.endpoint);
		if (this.adoptionLock) removeSocket(this.adoptionLock);
		this.adoptionLock = undefined;
		if (!this.server) return Promise.resolve();
		const server = this.server;
		this.server = undefined;
		return new Promise((resolveStop) => server.close(() => resolveStop()));
	}

	/** Stops IPC but keeps the owner lease until a successor session_start or process exit proves safety. */
	async beginDraining(): Promise<void> {
		withOwnerLock(this.owner.sessionId, () => {
			const path = sessionOwnerPath(this.owner.sessionId);
			const current = readOwner(path);
			if (current && ownerMatches(current, this.owner)) {
				this.owner.state = "draining";
				writeOwner(path, this.owner);
			}
		});
		await this.closeServer();
	}

	/** Explicit final cleanup, used only when the owner is known to be safely replaced or discarded. */
	async stop(): Promise<void> {
		await this.closeServer();
		withOwnerLock(this.owner.sessionId, () => unlinkIfOwned(sessionOwnerPath(this.owner.sessionId), this.owner));
	}
}
