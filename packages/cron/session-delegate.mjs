// Session owner delegation for hosts that put a Pi session's process to sleep.
//
// A host (for example Picky) may stop the process that owns a persisted Pi session while the session stays
// open to its user. Without an owner the daemon resumes the session with a separate `pi --mode rpc` process,
// whose turn the host never sees. A delegate holds the session's owner lease instead:
//
// - It never accepts a delivery. Every valid request is answered `deferred` and reported to the host, which
//   starts the session's real process again. The daemon retries on its next tick.
// - Before the host starts that process it calls `reserveForSuccessor()`. The lease becomes a `reserved` record
//   held by this process, which the daemon treats as a transition (it defers). The returned value goes into the
//   new process's `PI_CRON_SESSION_RESERVATION`, and its cron extension adopts the reservation exactly as a
//   cron-started RPC session does. From then on the daemon delivers live to that process (`queued`).
//
// The module has no Pi dependency, so a host process that does not load Pi can import it. The cron extension
// reports this module's path on the `cron.session-delegate.info` event-bus channel; hosts load it from there
// instead of from a fixed install path. The owner record format, locks, and frames stay private to this package.

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownProcessStartIdentity, processLiveness } from "./process-identity.mjs";
import { withFileLock, writeAtomicFile } from "./store-lock.mjs";

export const SESSION_DELEGATE_VERSION = 1;
export const SESSION_DELEGATE_QUERY_CHANNEL = "cron.session-delegate.query";
export const SESSION_DELEGATE_INFO_CHANNEL = "cron.session-delegate.info";

/** Absolute path of this module, which the extension reports to hosts on `SESSION_DELEGATE_INFO_CHANNEL`. */
export function getSessionDelegatePath() {
	return join(dirname(fileURLToPath(import.meta.url)), "session-delegate.mjs");
}

const MAX_FRAME_BYTES = 64 * 1024;
const READ_DEADLINE_MS = 10_000;

/** A live owner other than a provably dead one holds the session. */
export class SessionDelegateBusyError extends Error {
	constructor(state) {
		super(`a live cron session owner holds this session (${state})`);
		this.name = "SessionDelegateBusyError";
		this.code = "busy";
	}
}

function sessionKey(sessionId) {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

function registryDir(agentDir) {
	return join(agentDir, "cron", "sessions");
}

/** Same path rule as the extension's `sessionOwnerPath`, for the given agent directory. */
export function delegateOwnerPath(agentDir, sessionId) {
	return join(registryDir(agentDir), `${sessionKey(sessionId)}.json`);
}

function ownerLockPath(agentDir, sessionId) {
	return join(registryDir(agentDir), `${sessionKey(sessionId)}.lock`);
}

function adoptionLockPath(agentDir, sessionId, generation) {
	return join(registryDir(agentDir), `${sessionKey(sessionId)}-${generation}.adopt`);
}

function endpointFor(sessionId, generation) {
	return join(tmpdir(), `pc-${sessionKey(sessionId)}-${generation.slice(0, 8)}.sock`);
}

function readOwner(path) {
	try {
		const owner = JSON.parse(readFileSync(path, "utf8"));
		return owner && typeof owner === "object" ? owner : undefined;
	} catch {
		return undefined;
	}
}

function removeFile(path) {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {}
}

function validateSessionFile(sessionId, sessionFile) {
	const canonical = realpathSync(sessionFile);
	const header = readFileSync(canonical, "utf8").split("\n", 1)[0];
	let parsed;
	try {
		parsed = JSON.parse(header);
	} catch {
		throw new Error("session file has an invalid Pi session header");
	}
	if (parsed?.type !== "session" || parsed.id !== sessionId) {
		throw new Error("session file does not belong to the persisted session");
	}
	return canonical;
}

function sameHolder(record, owner) {
	return (
		record?.generation === owner.generation &&
		record.pid === owner.pid &&
		record.processIdentity === owner.processIdentity &&
		record.sessionId === owner.sessionId
	);
}

/**
 * Takes the session's owner lease for this process. Resolves once the delegate endpoint listens and the record
 * is `active`. Rejects with `SessionDelegateBusyError` while another live owner (a Pi process, a reservation of
 * the daemon, or another delegate) holds the lease; a provably dead owner is replaced.
 *
 * `onDeferred({ id })` runs after each valid delivery was answered `deferred`; it should start the session's
 * process. It never receives the prompt: the daemon delivers that again to the process that adopts the lease.
 */
export async function claimDelegatedSessionOwner({ agentDir, sessionId, sessionFile, onDeferred }) {
	if (typeof agentDir !== "string" || !agentDir) throw new Error("agentDir is required");
	if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
	const owner = new DelegatedSessionOwner(agentDir, sessionId, validateSessionFile(sessionId, sessionFile), onDeferred);
	await owner.start();
	return owner;
}

class DelegatedSessionOwner {
	#agentDir;
	#owner;
	#onDeferred;
	#server;
	#sockets = new Set();
	#reservation;
	#stopped = false;

	constructor(agentDir, sessionId, sessionFile, onDeferred) {
		this.#agentDir = agentDir;
		this.#onDeferred = onDeferred;
		const generation = randomUUID();
		this.#owner = {
			sessionId,
			sessionFile,
			endpoint: endpointFor(sessionId, generation),
			pid: process.pid,
			processIdentity: ownProcessStartIdentity(),
			generation,
			state: "starting",
			delegate: true,
		};
	}

	/** `active` while it listens, `reserved` after `reserveForSuccessor`, `stopped` after `stop` or a lost lease. */
	get state() {
		if (this.#stopped) return "stopped";
		return this.#reservation ? "reserved" : this.#owner.state;
	}

	get endpoint() {
		return this.#owner.endpoint;
	}

	#path() {
		return delegateOwnerPath(this.#agentDir, this.#owner.sessionId);
	}

	#withLock(action) {
		return withFileLock(ownerLockPath(this.#agentDir, this.#owner.sessionId), action);
	}

	async start() {
		mkdirSync(registryDir(this.#agentDir), { recursive: true });
		this.#withLock(() => {
			const existing = readOwner(this.#path());
			if (existsSync(this.#path()) && !existing) throw new Error("invalid cron session owner record");
			if (existing) {
				if (processLiveness(existing.pid, existing.processIdentity) !== "dead") {
					throw new SessionDelegateBusyError(existing.state);
				}
				unlinkSync(this.#path());
			}
			writeAtomicFile(this.#path(), `${JSON.stringify(this.#owner)}\n`);
		});
		this.#server = createServer((socket) => this.#handle(socket));
		try {
			await new Promise((resolveListen, reject) => {
				this.#server.once("error", reject);
				this.#server.listen(this.#owner.endpoint, () => {
					this.#server.removeListener("error", reject);
					resolveListen();
				});
			});
			chmodSync(this.#owner.endpoint, 0o600);
			this.#withLock(() => {
				if (!sameHolder(readOwner(this.#path()), this.#owner)) {
					throw new Error("cron session ownership changed before the delegate became ready");
				}
				this.#owner.state = "active";
				writeAtomicFile(this.#path(), `${JSON.stringify(this.#owner)}\n`);
			});
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	#handle(socket) {
		this.#sockets.add(socket);
		let input = "";
		let handled = false;
		const deadline = setTimeout(() => socket.destroy(), READ_DEADLINE_MS);
		socket.setEncoding("utf8");
		socket.on("close", () => {
			clearTimeout(deadline);
			this.#sockets.delete(socket);
		});
		socket.on("error", () => socket.destroy());
		socket.on("data", (chunk) => {
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
			let request;
			try {
				request = JSON.parse(input.slice(0, newline));
			} catch {
				socket.end('{"ok":false,"error":"invalid request"}\n');
				return;
			}
			if (!this.#matches(request)) {
				socket.end('{"ok":false,"error":"session identity mismatch"}\n');
				return;
			}
			// The delegate cannot run the prompt. Deferred tells the daemon nothing was queued, so it retries.
			socket.end(
				`${JSON.stringify({ id: request.id, ok: false, deferred: true, error: "session owner is waking" })}\n`,
			);
			try {
				this.#onDeferred?.({ id: request.id });
			} catch {}
		});
	}

	#matches(request) {
		if (!request || typeof request !== "object" || Array.isArray(request)) return false;
		if (typeof request.id !== "string" || typeof request.prompt !== "string") return false;
		if (request.generation !== this.#owner.generation || request.sessionId !== this.#owner.sessionId) return false;
		try {
			return typeof request.sessionFile === "string" && realpathSync(request.sessionFile) === this.#owner.sessionFile;
		} catch {
			return false;
		}
	}

	async #closeServer() {
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		removeFile(this.#owner.endpoint);
		const server = this.#server;
		this.#server = undefined;
		if (server) await new Promise((resolveClose) => server.close(() => resolveClose()));
	}

	/**
	 * Turns the active lease into a reservation for the process the host is about to start, and stops listening.
	 * Returns the value for that process's `PI_CRON_SESSION_RESERVATION`. Throws when the lease is no longer this
	 * delegate's. The reservation stays this process's until the successor adopts it or `releaseReservation` runs.
	 */
	async reserveForSuccessor() {
		if (this.#stopped || this.#reservation || this.#owner.state !== "active") {
			throw new Error(`the delegate cannot reserve from state ${this.state}`);
		}
		const reservation = {
			sessionId: this.#owner.sessionId,
			sessionFile: this.#owner.sessionFile,
			endpoint: "",
			pid: this.#owner.pid,
			processIdentity: this.#owner.processIdentity,
			generation: randomUUID(),
			state: "reserved",
			delegate: true,
		};
		this.#withLock(() => {
			if (!sameHolder(readOwner(this.#path()), this.#owner)) {
				throw new Error("cron session ownership changed before the reservation");
			}
			writeAtomicFile(this.#path(), `${JSON.stringify(reservation)}\n`);
		});
		this.#reservation = reservation;
		await this.#closeServer();
		const { sessionId, sessionFile, generation, pid, processIdentity } = reservation;
		return JSON.stringify({ sessionId, sessionFile, generation, pid, processIdentity });
	}

	/**
	 * Ends a reservation the successor did not adopt (it failed to start, or runs without the cron extension).
	 * Returns `released` when the reservation was removed, `adopted` when another owner holds the lease now, and
	 * `none` when there was no reservation. The delegate is stopped afterwards either way.
	 */
	releaseReservation() {
		const reservation = this.#reservation;
		if (!reservation) return "none";
		const released = this.#withLock(() => {
			const current = readOwner(this.#path());
			if (current?.state !== "reserved" || !sameHolder(current, reservation)) return false;
			unlinkSync(this.#path());
			return true;
		});
		if (released) removeFile(adoptionLockPath(this.#agentDir, reservation.sessionId, reservation.generation));
		this.#stopped = true;
		return released ? "released" : "adopted";
	}

	/** Stops listening and removes the lease while it is still this delegate's (active or an unadopted reservation). */
	async stop() {
		if (this.#reservation) {
			this.releaseReservation();
			return;
		}
		this.#stopped = true;
		await this.#closeServer();
		try {
			this.#withLock(() => {
				if (sameHolder(readOwner(this.#path()), this.#owner)) unlinkSync(this.#path());
			});
		} catch {}
	}
}
