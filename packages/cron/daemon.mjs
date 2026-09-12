#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { ownProcessStartIdentity, processLiveness } from "./process-identity.mjs";
import { withFileLock, withStoreLock, writeAtomicFile } from "./store-lock.mjs";

const TICK_INTERVAL_MS = Number.parseInt(process.env.PI_CRON_TICK_INTERVAL_MS || "30000", 10);
const RETRY_LOCK_INTERVAL_MS = Number.parseInt(process.env.PI_CRON_RETRY_LOCK_INTERVAL_MS || "60000", 10);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.PI_CRON_JOB_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const KILL_GRACE_MS = Number.parseInt(process.env.PI_CRON_JOB_KILL_GRACE_MS || "5000", 10);
const STORE_VERSION = 2;

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const cronDir = join(agentDir, "cron");
const jobsPath = join(cronDir, "jobs.json");
const pidPath = join(cronDir, "daemon.pid");
const daemonLogPath = join(cronDir, "daemon.log");
const runsDir = join(cronDir, "runs");
const sessionsDir = join(cronDir, "sessions");
const SESSION_DELIVERY_TIMEOUT_MS = Number.parseInt(process.env.PI_CRON_SESSION_DELIVERY_TIMEOUT_MS || "10000", 10);

const running = new Set();
const runningSessions = new Set();
const rpcChildren = new Set();
let lockHeld = false;
let tickTimer;
let retryTimer;
let ticking = false;

function nowIso() {
	return new Date().toISOString();
}

function ensureDirs() {
	mkdirSync(cronDir, { recursive: true });
	mkdirSync(runsDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
}

function log(message, details = undefined) {
	ensureDirs();
	const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
	writeFileSync(daemonLogPath, `[${nowIso()}] ${message}${suffix}\n`, { flag: "a" });
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPid() {
	try {
		const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
		return Number.isInteger(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function tryAcquireLock() {
	ensureDirs();
	const existing = readPid();
	if (existing && existing !== process.pid && isProcessAlive(existing)) {
		return false;
	}
	if (existing) {
		try {
			unlinkSync(pidPath);
		} catch {}
	}
	try {
		writeFileSync(pidPath, String(process.pid), { flag: "wx" });
		lockHeld = true;
		return true;
	} catch (error) {
		if (error?.code === "EEXIST") return false;
		throw error;
	}
}

function releaseLock() {
	if (!lockHeld) return;
	try {
		const pid = readPid();
		if (pid === process.pid) unlinkSync(pidPath);
	} catch {}
	lockHeld = false;
}

function emptyStore() {
	return { version: STORE_VERSION, jobs: [], history: [] };
}

function isCompletedOneShot(job) {
	return job.disabledReason === "completed_once";
}

function loadStoreUnsafe() {
	if (!existsSync(jobsPath)) return emptyStore();
	try {
		const parsed = JSON.parse(readFileSync(jobsPath, "utf-8"));
		if (!Array.isArray(parsed?.jobs)) return emptyStore();
		if (parsed.version === 1) {
			return {
				version: STORE_VERSION,
				jobs: parsed.jobs.filter((job) => !isCompletedOneShot(job)),
				history: parsed.jobs.filter(isCompletedOneShot),
			};
		}
		if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.history)) return emptyStore();
		return { version: STORE_VERSION, jobs: parsed.jobs, history: parsed.history };
	} catch (error) {
		log("failed to load jobs", { error: String(error) });
		return emptyStore();
	}
}

function historyTimestamp(job) {
	return job.completedAt || job.lastRunAt || job.updatedAt;
}

function saveStoreUnsafe(store) {
	const jobs = [...store.jobs].sort((a, b) => a.id.localeCompare(b.id));
	const history = [...store.history].sort(
		(a, b) => historyTimestamp(b).localeCompare(historyTimestamp(a)) || a.id.localeCompare(b.id),
	);
	writeAtomicFile(jobsPath, `${JSON.stringify({ version: STORE_VERSION, jobs, history }, null, 2)}\n`);
}

function withStoreTransaction(update) {
	ensureDirs();
	return withStoreLock(cronDir, () => {
		const store = loadStoreUnsafe();
		const result = update(store);
		saveStoreUnsafe(store);
		return result;
	});
}

function completeJob(id, runToken, updater) {
	return withStoreTransaction((store) => {
		const index = store.jobs.findIndex((job) => job.id === id);
		if (index === -1) return undefined;
		const current = store.jobs[index];
		if (current.runToken !== runToken) return undefined;
		const completed = {
			...updater(current),
			running: false,
			runToken: undefined,
			lastRunPromptFile: current.runPromptFile,
			runPromptFile: undefined,
			updatedAt: nowIso(),
		};
		if (current.kind !== "cron" || current.once) {
			store.jobs.splice(index, 1);
			store.history.push(completed);
		} else {
			store.jobs[index] = completed;
		}
		return completed;
	});
}

function parseField(field, min, max) {
	const values = new Set();
	for (const rawPart of field.split(",")) {
		const part = rawPart.trim();
		if (!part) throw new Error(`Empty cron field part in "${field}"`);
		const [rangeStr, stepStr] = part.split("/");
		const step = stepStr === undefined ? 1 : Number.parseInt(stepStr, 10);
		if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step "${stepStr}" in field "${field}"`);

		let lo;
		let hi;
		if (rangeStr === "*") {
			lo = min;
			hi = max;
		} else if (rangeStr.includes("-")) {
			const [rawLo, rawHi] = rangeStr.split("-");
			lo = Number.parseInt(rawLo, 10);
			hi = Number.parseInt(rawHi, 10);
		} else {
			lo = Number.parseInt(rangeStr, 10);
			hi = lo;
		}

		if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`Invalid value in field "${field}"`);
		if (lo < min || hi > max || lo > hi) {
			throw new Error(`Value out of range in "${field}" (allowed ${min}-${max})`);
		}
		for (let value = lo; value <= hi; value += step) values.add(value);
	}
	return values;
}

function matchesCron(expression, date) {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`Invalid cron expression: ${expression}`);
	return (
		parseField(fields[0], 0, 59).has(date.getMinutes()) &&
		parseField(fields[1], 0, 23).has(date.getHours()) &&
		parseField(fields[2], 1, 31).has(date.getDate()) &&
		parseField(fields[3], 1, 12).has(date.getMonth() + 1) &&
		parseField(fields[4], 0, 6).has(date.getDay())
	);
}

function nextCronRun(expression, from = new Date()) {
	const cursor = new Date(from);
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);
	const maxChecks = 60 * 24 * 366 * 5;
	for (let i = 0; i < maxChecks; i++) {
		if (matchesCron(expression, cursor)) return new Date(cursor);
		cursor.setMinutes(cursor.getMinutes() + 1);
	}
	throw new Error(`Could not find next run for cron expression: ${expression}`);
}

function minuteKey(date) {
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

function computeInitialNextRun(job, now) {
	if (job.kind === "cron") {
		if (!job.schedule) throw new Error("cron job missing schedule");
		const last = job.lastRunAt ? new Date(job.lastRunAt) : undefined;
		if (matchesCron(job.schedule, now) && (!last || minuteKey(last) !== minuteKey(now))) {
			return now.toISOString();
		}
		return nextCronRun(job.schedule, now).toISOString();
	}
	if (!job.runAt) throw new Error(`${job.kind} job missing runAt`);
	const runAt = new Date(job.runAt);
	if (Number.isNaN(runAt.getTime())) throw new Error(`invalid runAt: ${job.runAt}`);
	return runAt.toISOString();
}

function normalizeNextRuns(now) {
	return withStoreTransaction((store) => {
		for (let index = 0; index < store.jobs.length; index++) {
			const job = store.jobs[index];
			if (!job.enabled || job.nextRunAt) continue;
			try {
				store.jobs[index] = { ...job, nextRunAt: computeInitialNextRun(job, now), updatedAt: now.toISOString() };
			} catch (error) {
				log("failed to compute next run", { job: job.id, error: String(error) });
				store.jobs[index] = {
					...job,
					enabled: false,
					disabledReason: "error",
					updatedAt: now.toISOString(),
				};
			}
		}
		return store.jobs;
	});
}

function isDue(job, now) {
	if (!job.enabled || !job.nextRunAt || running.has(job.id)) return false;
	if (jobScope(job) === "session" && job.sessionId && runningSessions.has(job.sessionId)) return false;
	const nextRunAt = new Date(job.nextRunAt);
	return !Number.isNaN(nextRunAt.getTime()) && nextRunAt.getTime() <= now.getTime();
}

function claimDueJob(id, now) {
	return withStoreTransaction((store) => {
		const index = store.jobs.findIndex((job) => job.id === id);
		const job = store.jobs[index];
		if (!job || !isDue(job, now)) return undefined;
		const runToken = randomUUID();
		const runPromptFile = join(runsDir, job.id, `${runToken}.prompt.md`);
		const prompt = readFileSync(job.promptFile, "utf8");
		mkdirSync(join(runsDir, job.id), { recursive: true });
		writeFileSync(runPromptFile, prompt, { encoding: "utf8", mode: 0o600 });
		store.jobs[index] = { ...job, running: true, runToken, runPromptFile, updatedAt: nowIso() };
		return store.jobs[index];
	});
}

function readRunPrompt(job) {
	const prompt = readFileSync(job.runPromptFile || job.promptFile, "utf8");
	// writePromptFile persists exactly one delimiter LF. Remove only that delimiter for session command dispatch.
	return prompt.endsWith("\n") ? prompt.slice(0, -1) : prompt;
}

function resolvePiBinary() {
	return process.env.PI_CRON_PI_BIN || "pi";
}

function jobScope(job) {
	return job.scope || "user";
}

function sessionKey(sessionId) {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

function ownerPath(sessionId) {
	return join(sessionsDir, `${sessionKey(sessionId)}.json`);
}

function adoptionLockPath(sessionId, generation) {
	return join(sessionsDir, `${sessionKey(sessionId)}-${generation}.adopt`);
}

function canonicalSessionFile(sessionFile) {
	return realpathSync(sessionFile);
}

function sessionOwnerLockPath(sessionId) {
	return join(sessionsDir, `${sessionKey(sessionId)}.lock`);
}

function withSessionOwnerLock(sessionId, action) {
	return withFileLock(sessionOwnerLockPath(sessionId), action);
}

function ownerIsProvablyDead(owner) {
	return processLiveness(owner.pid, owner.processIdentity) === "dead";
}

function validateSessionFile(sessionId, sessionFile) {
	const canonical = canonicalSessionFile(sessionFile);
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

function isValidOwner(owner, job, sessionFile) {
	return (
		owner &&
		typeof owner === "object" &&
		owner.sessionId === job.sessionId &&
		typeof owner.sessionFile === "string" &&
		owner.sessionFile === sessionFile &&
		typeof owner.generation === "string" &&
		Number.isInteger(owner.pid) &&
		(owner.processIdentity === undefined || typeof owner.processIdentity === "string") &&
		typeof owner.state === "string" &&
		["active", "reserved", "starting", "draining"].includes(owner.state) &&
		typeof owner.endpoint === "string"
	);
}

function readSessionOwnerUnsafe(job, sessionFile) {
	const path = ownerPath(job.sessionId);
	if (!existsSync(path)) return undefined;
	let owner;
	try {
		owner = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`invalid session owner record: ${String(error)}`);
	}
	if (!isValidOwner(owner, job, sessionFile)) throw new Error("invalid session owner record");
	return owner;
}

function readSessionOwner(job, sessionFile) {
	const owner = readSessionOwnerUnsafe(job, sessionFile);
	if (!owner || !ownerIsProvablyDead(owner)) return owner;
	return withSessionOwnerLock(job.sessionId, () => {
		const current = readSessionOwnerUnsafe(job, sessionFile);
		if (current && ownerIsProvablyDead(current)) {
			try {
				unlinkSync(ownerPath(job.sessionId));
			} catch {}
			return undefined;
		}
		return current;
	});
}

function reserveSessionOwner(job, sessionFile) {
	return withSessionOwnerLock(job.sessionId, () => {
		const path = ownerPath(job.sessionId);
		const existing = readSessionOwnerUnsafe(job, sessionFile);
		if (existing && !ownerIsProvablyDead(existing))
			throw new DeferredSessionDelivery("another session owner acquired the lease before RPC reservation");
		if (existing) unlinkSync(path);
		const reservation = {
			sessionId: job.sessionId,
			sessionFile,
			endpoint: "",
			pid: process.pid,
			processIdentity: ownProcessStartIdentity(),
			generation: randomUUID(),
			state: "reserved",
		};
		writeAtomicFile(path, `${JSON.stringify(reservation)}\n`);
		return reservation;
	});
}

function releaseReservation(reservation) {
	withSessionOwnerLock(reservation.sessionId, () => {
		const path = ownerPath(reservation.sessionId);
		try {
			const current = JSON.parse(readFileSync(path, "utf8"));
			if (
				current.state === "reserved" &&
				current.generation === reservation.generation &&
				current.pid === reservation.pid &&
				current.processIdentity === reservation.processIdentity
			) {
				unlinkSync(path);
			}
		} catch {}
	});
	try {
		unlinkSync(adoptionLockPath(reservation.sessionId, reservation.generation));
	} catch {}
}

function reservationAdopted(job, sessionFile, reservation, childPid) {
	try {
		const owner = JSON.parse(readFileSync(ownerPath(job.sessionId), "utf8"));
		return (
			isValidOwner(owner, job, sessionFile) &&
			owner.state === "active" &&
			owner.generation === reservation.generation &&
			owner.pid === childPid &&
			processLiveness(owner.pid, owner.processIdentity) !== "dead" &&
			owner.endpoint
		);
	} catch {
		return false;
	}
}

class DeferredSessionDelivery extends Error {
	constructor(message) {
		super(message);
		this.name = "DeferredSessionDelivery";
	}
}

class UnsentSessionDelivery extends Error {
	constructor(cause) {
		super(cause.message, { cause });
		this.name = "UnsentSessionDelivery";
	}
}

function sessionOwnerIsTransitioning(owner) {
	return owner && ["reserved", "starting", "draining"].includes(owner.state);
}

function deferClaim(id, runToken) {
	return withStoreTransaction((store) => {
		const job = store.jobs.find((candidate) => candidate.id === id);
		if (!job || job.runToken !== runToken) return undefined;
		job.running = false;
		job.runToken = undefined;
		job.runPromptFile = undefined;
		job.updatedAt = nowIso();
		return job;
	});
}

function deliverToLiveSession(job, owner, sessionFile) {
	return new Promise((resolveDelivery, reject) => {
		const requestId = randomUUID();
		const socket = createConnection(owner.endpoint);
		let response = "";
		let settled = false;
		let requestSent = false;
		const timeout = setTimeout(() => finish(new Error("live session delivery timed out")), SESSION_DELIVERY_TIMEOUT_MS);
		function finish(error, value) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			if (error) reject(requestSent ? error : new UnsentSessionDelivery(error));
			else resolveDelivery(value);
		}
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			try {
				const frame = `${JSON.stringify({ id: requestId, generation: owner.generation, sessionId: job.sessionId, sessionFile, prompt: readRunPrompt(job) })}\n`;
				requestSent = true;
				socket.write(frame);
			} catch (error) {
				finish(error);
			}
		});
		socket.on("data", (chunk) => {
			response += chunk;
			if (Buffer.byteLength(response) > 64 * 1024) return finish(new Error("live session response too large"));
			if (!response.includes("\n")) return;
			try {
				const result = JSON.parse(response.slice(0, response.indexOf("\n")));
				if (result?.id === requestId && result.ok === false && result.deferred === true) {
					return finish(new DeferredSessionDelivery(result.error || "live session is transitioning"));
				}
				if (!result || typeof result !== "object" || result.id !== requestId || !result.ok) {
					return finish(new Error(result?.error || "live session rejected delivery"));
				}
				finish(undefined, { outcome: "queued" });
			} catch {
				finish(new Error("malformed live session response"));
			}
		});
		socket.on("error", (error) => finish(error));
		socket.on("end", () => {
			if (!settled) finish(new Error("live session closed delivery connection"));
		});
	});
}

function runSessionRpc(job, sessionFile) {
	return new Promise((resolveRpc, reject) => {
		let reservation;
		try {
			reservation = reserveSessionOwner(job, sessionFile);
		} catch (error) {
			reject(error);
			return;
		}
		const stateId = randomUUID();
		const promptId = randomUUID();
		let child;
		try {
			child = spawn(resolvePiBinary(), ["--mode", "rpc", "--session", sessionFile], {
				cwd: job.cwd || agentDir,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					PI_CRON_SESSION_RESERVATION: JSON.stringify(reservation),
				},
			});
		} catch (error) {
			releaseReservation(reservation);
			reject(error);
			return;
		}
		rpcChildren.add(child);
		let stdout = "";
		let stderr = "";
		let promptIssued = false;
		let promptAccepted = false;
		let postPromptStateId;
		let settled = false;
		let closing = false;
		let complete;
		let killTimer;
		let timeout;
		function appendStderr(value) {
			stderr = `${stderr}${value}`.slice(-64 * 1024);
		}
		function stopChild() {
			if (closing) return;
			closing = true;
			try {
				child.kill("SIGTERM");
			} catch {}
			killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, KILL_GRACE_MS);
		}
		function finish(error, value) {
			if (complete) return;
			complete = { error, value };
			clearTimeout(timeout);
			stopChild();
		}
		function send(command) {
			if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
				finish(new Error("same-session RPC stdin is not writable"));
				return false;
			}
			try {
				child.stdin.write(`${JSON.stringify(command)}\n`);
				return true;
			} catch (error) {
				finish(error);
				return false;
			}
		}
		function handle(line) {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (!message || typeof message !== "object") return;
			if (message.type === "response" && message.command === "get_state") {
				const state = message.data;
				if (message.id === stateId) {
					if (
						!message.success ||
						state?.sessionId !== job.sessionId ||
						state?.sessionFile !== sessionFile ||
						!reservationAdopted(job, sessionFile, reservation, child.pid)
					) {
						finish(new Error("RPC did not adopt the reserved persisted session"));
						return;
					}
					promptIssued = send({
						id: promptId,
						type: "prompt",
						message: readRunPrompt(job),
						streamingBehavior: "followUp",
					});
					return;
				}
				if (
					message.id === postPromptStateId &&
					message.success &&
					!state?.isStreaming &&
					!state?.isCompacting &&
					state?.pendingMessageCount === 0
				) {
					finish(undefined, { outcome: "settled" });
				}
				return;
			}
			if (message.type === "response" && message.command === "prompt") {
				if (message.id !== promptId) return;
				if (!message.success)
					return finish(new Error(`RPC rejected session prompt: ${message.error || "unknown error"}`));
				promptAccepted = true;
				if (settled && promptIssued) {
					finish(undefined, { outcome: "settled" });
					return;
				}
				postPromptStateId = randomUUID();
				send({ id: postPromptStateId, type: "get_state" });
				return;
			}
			if (message.type === "agent_settled" && promptIssued && promptAccepted) {
				settled = true;
				finish(undefined, { outcome: "settled" });
			}
		}
		timeout = setTimeout(() => finish(new Error("same-session RPC timed out")), DEFAULT_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (Buffer.byteLength(stdout) > 256 * 1024) return finish(new Error("same-session RPC stdout exceeded limit"));
			let newline = stdout.indexOf("\n");
			while (newline >= 0) {
				const line = stdout.slice(0, newline);
				stdout = stdout.slice(newline + 1);
				handle(line);
				newline = stdout.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk) => appendStderr(chunk.toString()));
		child.stdin.on("error", (error) => finish(error));
		child.on("error", (error) => finish(error));
		child.on("close", (code, signal) => {
			rpcChildren.delete(child);
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			releaseReservation(reservation);
			if (!complete)
				return reject(
					new Error(`same-session RPC exited before settling (code ${code}, signal ${signal}): ${stderr.trim()}`),
				);
			if (complete.error)
				return reject(
					new Error(
						`${complete.error instanceof Error ? complete.error.message : String(complete.error)}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
					),
				);
			resolveRpc({ ...complete.value, stdout, stderr });
		});
		send({ id: stateId, type: "get_state" });
	});
}

async function runSessionJob(job, runLogPath) {
	if (!job.sessionId || !job.sessionFile) throw new Error("session job is missing persisted session owner fields");
	const sessionFile = validateSessionFile(job.sessionId, job.sessionFile);
	const owner = readSessionOwner(job, sessionFile);
	if (sessionOwnerIsTransitioning(owner)) {
		throw new DeferredSessionDelivery(`session owner is ${owner.state}`);
	}
	let result;
	try {
		result = owner ? await deliverToLiveSession(job, owner, sessionFile) : await runSessionRpc(job, sessionFile);
	} catch (error) {
		// Only retry when no request was sent. A lost acknowledgement can hide an already accepted prompt.
		if (error instanceof UnsentSessionDelivery) {
			const current = readSessionOwner(job, sessionFile);
			if (!current || current.generation !== owner?.generation || sessionOwnerIsTransitioning(current)) {
				throw new DeferredSessionDelivery("session ownership changed before the request was sent");
			}
		}
		throw error;
	}
	writeFileSync(
		runLogPath,
		[
			`# cron session delivery: ${job.id}`,
			`deliveredAt: ${nowIso()}`,
			`outcome: ${result.outcome}`,
			"",
			"The original session owns task execution. queued means live delivery was accepted. settled means the cron RPC delivery completed, not that the task succeeded.",
			"",
		].join("\n"),
		"utf8",
	);
	return { exitCode: undefined, outcome: result.outcome };
}

function runJobProcess(job, runLogPath) {
	if (jobScope(job) === "session") return runSessionJob(job, runLogPath);
	return new Promise((resolve) => {
		const piBin = resolvePiBinary();
		const args = ["-p", "--no-session", `@${job.runPromptFile || job.promptFile}`];
		const child = spawn(piBin, args, {
			cwd: job.cwd || agentDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let killTimer;
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {}
			killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
			}, KILL_GRACE_MS);
		}, DEFAULT_TIMEOUT_MS);

		function finish(code) {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			const exitCode = timedOut ? 124 : (code ?? 1);
			const content = [
				`# cron run: ${job.id}`,
				`startedAt: ${nowIso()}`,
				`exitCode: ${exitCode}`,
				`timedOut: ${timedOut}`,
				"",
				"## stdout",
				stdout.trimEnd(),
				"",
				"## stderr",
				stderr.trimEnd(),
				"",
			].join("\n");
			writeFileSync(runLogPath, content, "utf-8");
			resolve({ exitCode, stdout, stderr, timedOut });
		}

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			stderr += `\n${error.message}`;
			finish(1);
		});
		child.on("close", finish);
	});
}

async function executeJob(candidate) {
	const job = claimDueJob(candidate.id, new Date());
	if (!job) return;
	running.add(job.id);
	if (jobScope(job) === "session" && job.sessionId) runningSessions.add(job.sessionId);
	const startedAt = new Date();
	const runId = startedAt.toISOString().replace(/[:.]/g, "-");
	const jobRunsDir = join(runsDir, job.id);
	mkdirSync(jobRunsDir, { recursive: true });
	const runLogPath = join(jobRunsDir, `${runId}.log`);

	log("job start", { job: job.id, promptFile: job.promptFile });

	try {
		const result = await runJobProcess(job, runLogPath);
		const finishedAt = new Date();
		completeJob(job.id, job.runToken, (current) => {
			const oneShot = current.kind !== "cron" || current.once;
			const nextRunAt =
				oneShot || !current.schedule ? undefined : nextCronRun(current.schedule, finishedAt).toISOString();
			return {
				...current,
				enabled: oneShot ? false : current.enabled,
				running: false,
				lastRunAt: finishedAt.toISOString(),
				nextRunAt,
				lastExitCode: result.exitCode,
				lastRunLog: runLogPath,
				lastDeliveryOutcome: jobScope(current) === "session" ? result.outcome : current.lastDeliveryOutcome,
				lastDeliveryError: jobScope(current) === "session" ? undefined : current.lastDeliveryError,
				disabledReason: oneShot ? "completed_once" : current.disabledReason,
				completedAt: oneShot ? finishedAt.toISOString() : current.completedAt,
			};
		});
		log("job complete", {
			job: job.id,
			outcome: result.outcome ?? "headless_exit",
			exitCode: result.exitCode,
			runLogPath,
		});
	} catch (error) {
		if (error instanceof DeferredSessionDelivery) {
			deferClaim(job.id, job.runToken);
			// No delivery was accepted, so this private snapshot is not execution history.
			try {
				unlinkSync(job.runPromptFile);
			} catch {}
			log("session delivery deferred", { job: job.id, reason: error.message });
			return;
		}
		const finishedAt = new Date();
		const diagnostic = error instanceof Error ? error.message : String(error);
		if (!existsSync(runLogPath)) {
			writeFileSync(
				runLogPath,
				[`# cron run failure: ${job.id}`, `failedAt: ${nowIso()}`, "", "## error", diagnostic, ""].join("\n"),
				"utf8",
			);
		}
		completeJob(job.id, job.runToken, (current) => {
			const oneShot = current.kind !== "cron" || current.once;
			return {
				...current,
				enabled: oneShot ? false : current.enabled,
				running: false,
				lastRunAt: finishedAt.toISOString(),
				lastExitCode: 1,
				lastRunLog: runLogPath,
				lastDeliveryOutcome: jobScope(current) === "session" ? "failed" : current.lastDeliveryOutcome,
				lastDeliveryError: jobScope(current) === "session" ? diagnostic : current.lastDeliveryError,
				disabledReason: oneShot ? "completed_once" : "error",
				completedAt: oneShot ? finishedAt.toISOString() : current.completedAt,
			};
		});
		log("job error", { job: job.id, error: diagnostic, runLogPath });
	} finally {
		running.delete(job.id);
		if (jobScope(job) === "session" && job.sessionId) runningSessions.delete(job.sessionId);
	}
}

async function tick() {
	if (!lockHeld || ticking) return;
	ticking = true;
	try {
		const now = new Date();
		const jobs = normalizeNextRuns(now);
		for (const job of jobs) {
			if (isDue(job, now)) void executeJob(job);
		}
	} finally {
		ticking = false;
	}
}

function startScheduler() {
	if (tickTimer) return;
	log("daemon scheduler started", { pid: process.pid });
	void tick();
	tickTimer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

function tryStart() {
	if (lockHeld) return;
	if (tryAcquireLock()) {
		startScheduler();
		return;
	}
	const holder = readPid();
	log("daemon waiting for lock", { holder });
}

function shutdown() {
	log("daemon shutting down", { pid: process.pid });
	for (const child of rpcChildren) {
		try {
			child.kill("SIGTERM");
		} catch {}
	}
	if (tickTimer) clearInterval(tickTimer);
	if (retryTimer) clearInterval(retryTimer);
	releaseLock();
	process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (error) => {
	log("uncaught exception", { error: error.stack || String(error) });
});
process.on("unhandledRejection", (reason) => {
	log("unhandled rejection", { error: String(reason) });
});

ensureDirs();
tryStart();
retryTimer = setInterval(tryStart, RETRY_LOCK_INTERVAL_MS);
