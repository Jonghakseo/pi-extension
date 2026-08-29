import { randomUUID } from "node:crypto";
import { readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { JobLog } from "./job-log.js";
import type { CompletedJob, NotificationBatcher } from "./notification-batcher.js";
import { validateCwd } from "./tool-schema.js";
import {
	type BashAsyncJob,
	isTerminalJobStatus,
	type JobTerminalCause,
	type StartResultDetails,
	type StatusResultDetails,
	terminalStatusForCause,
} from "./types.js";

export const DEFAULT_MAX_CONCURRENCY = 4;
export const MAX_RETAINED_JOBS = 20;
export const COMPLETED_JOB_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_MAX_CLOSED_LOG_BYTES = 1024 * 1024 * 1024;
const CLOSED_LOG_MARKER_SUFFIX = ".closed";

export interface StartJobInput {
	command: string;
	title?: string;
	cwd?: string;
	timeoutSeconds: number;
	context: ExtensionContext;
	acceptanceSignal?: AbortSignal;
}

export interface StartJobResult {
	ok: true;
	details: StartResultDetails;
}

export type KillResult = BashAsyncJob | undefined;

export interface JobOutputResult {
	job: BashAsyncJob;
	text: string;
	startOffset: number;
	nextOffset: number;
	retainedFromOffset: number;
	warning?: string;
}

export interface SessionEnvironment {
	PI_SESSION_ID?: string;
	PI_SESSION_FILE?: string;
	PI_PROVIDER?: string;
	PI_MODEL?: string;
	PI_REASONING_LEVEL?: string;
}

interface ExecutionOutcome {
	exitCode?: number | null;
	error?: unknown;
}

export interface ExecutionJob {
	id: string;
	command: string;
	cwd: string;
	timeoutSeconds: number;
	abortController: AbortController;
	environment: SessionEnvironment;
}

interface ExecutionBridge {
	onData: (data: Buffer) => void;
	settle: (outcome: ExecutionOutcome) => void;
	logError?: unknown;
}

interface ManagedJob extends BashAsyncJob {
	logWriter: JobLog;
	abortController: AbortController;
	environment: SessionEnvironment;
	requestedCause?: JobTerminalCause;
	execution?: Promise<void>;
	executionBridge?: ExecutionBridge;
	resolveSettlement: () => void;
	settled: Promise<void>;
	slotAcquired: boolean;
	finalized: boolean;
	settlementTimedOut?: boolean;
	settlementTimer?: ReturnType<typeof setTimeout>;
}

export interface ExecutionRequest {
	job: ExecutionJob;
	onData: (data: Buffer) => void;
}

export interface JobManagerOptions {
	maxConcurrency?: number;
	logsDirectory?: string;
	notifications?: NotificationBatcher;
	execute?: (request: ExecutionRequest) => Promise<{ exitCode: number | null }>;
	createLog?: (path: string) => JobLog;
	validateCwd?: typeof validateCwd;
	settlementGraceMs?: number;
	now?: () => number;
	maxClosedLogBytes?: number;
	onBeforeStaleLogRemove?: (path: string) => void | Promise<void>;
	onStateChange?: (job: BashAsyncJob) => void;
}

interface ClosedLog {
	path: string;
	markerPath: string;
	bytes: number;
	mtimeMs: number;
}

type ExecutionAdapter = (request: ExecutionRequest) => Promise<{ exitCode: number | null }>;

function titleFor(command: string, provided?: string): string {
	if (provided?.trim()) return provided;
	return command.trim().split(/\s+/)[0] || "bash job";
}

function safeSessionId(value: string | undefined): string {
	return (value ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function errorSummary(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function causeForError(error: unknown, requested: JobTerminalCause | undefined): JobTerminalCause {
	if (requested) return requested;
	const message = errorSummary(error);
	if (message.startsWith("timeout:") || message.includes("Command timed out")) return "timeout";
	if (message.includes("Command exited with code")) return "nonzero";
	return "spawn_error";
}

export function createBashAsyncOperations(
	baseOperations: BashOperations,
	onData: (data: Buffer) => void,
): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			const result = await baseOperations.exec(command, cwd, {
				...options,
				// bash_async owns the bounded output log. Forwarding to options.onData
				// would make Pi's OutputAccumulator create a second unbounded temp file.
				onData,
			});
			return result;
		},
	};
}

async function executeWithPi({ job, onData }: ExecutionRequest): Promise<{ exitCode: number | null }> {
	let executionResult: { exitCode: number | null } | undefined;
	const operations = createBashAsyncOperations(createLocalBashOperations(), (data) => onData(data));
	const capturingOperations: BashOperations = {
		exec: async (command, cwd, options) => {
			const result = await operations.exec(command, cwd, options);
			executionResult = result;
			return result;
		},
	};
	const definition = createBashToolDefinition(job.cwd, {
		operations: capturingOperations,
		exposeSessionEnvironment: false,
		spawnHook: ({ command, cwd, env }) => ({ command, cwd, env: { ...env, ...job.environment } }),
	});
	await definition.execute(
		job.id,
		{ command: job.command, timeout: job.timeoutSeconds === 0 ? undefined : job.timeoutSeconds },
		job.abortController.signal,
		undefined,
		undefined as never,
	);
	if (!executionResult) throw new Error("bash_async execution completed without an exit result");
	return executionResult;
}

async function runExecution(job: ExecutionJob, execute: ExecutionAdapter, bridge: ExecutionBridge): Promise<void> {
	try {
		const result = await execute({ job, onData: (data) => bridge.onData(data) });
		bridge.settle(bridge.logError === undefined ? { exitCode: result.exitCode } : { error: bridge.logError });
	} catch (error) {
		bridge.settle({ error: bridge.logError ?? error });
	} finally {
		bridge.onData = () => {};
		bridge.settle = () => {};
		bridge.logError = undefined;
	}
}

export class JobManager {
	private readonly jobs = new Map<string, ManagedJob>();
	private readonly queue: string[] = [];
	private readonly maxConcurrency: number;
	private readonly logsDirectory: string;
	private readonly now: () => number;
	private readonly executeAdapter: ExecutionAdapter;
	private readonly createLog: (path: string) => JobLog;
	private readonly cwdValidator: typeof validateCwd;
	private readonly settlementGraceMs: number;
	private readonly maxClosedLogBytes: number;
	private readonly onBeforeStaleLogRemove: ((path: string) => void | Promise<void>) | undefined;
	private logMaintenance = Promise.resolve();
	private running = 0;
	private shuttingDown = false;

	constructor(private readonly options: JobManagerOptions = {}) {
		const configured = options.maxConcurrency ?? Number(process.env.PI_BASH_ASYNC_MAX_CONCURRENCY);
		this.maxConcurrency = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_CONCURRENCY;
		this.logsDirectory = options.logsDirectory ?? join(tmpdir(), "pi-bash-async");
		this.now = options.now ?? Date.now;
		this.executeAdapter = options.execute ?? executeWithPi;
		this.createLog = options.createLog ?? ((path) => new JobLog({ path }));
		this.cwdValidator = options.validateCwd ?? validateCwd;
		this.settlementGraceMs = Math.max(1, options.settlementGraceMs ?? DEFAULT_KILL_GRACE_MS);
		const configuredClosedLogBytes = options.maxClosedLogBytes ?? DEFAULT_MAX_CLOSED_LOG_BYTES;
		this.maxClosedLogBytes = Number.isFinite(configuredClosedLogBytes)
			? Math.max(0, Math.floor(configuredClosedLogBytes))
			: DEFAULT_MAX_CLOSED_LOG_BYTES;
		this.onBeforeStaleLogRemove = options.onBeforeStaleLogRemove;
		this.scheduleLogMaintenance();
	}

	async start(input: StartJobInput): Promise<StartJobResult | { ok: false; error: string }> {
		if (this.shuttingDown) return { ok: false, error: "bash_async is shutting down and cannot accept new jobs." };
		if (input.acceptanceSignal?.aborted)
			return { ok: false, error: "bash_async start was cancelled before job acceptance." };
		const cwd = await this.cwdValidator(input.cwd, input.context.cwd);
		if (!cwd.ok) return cwd;
		if (input.acceptanceSignal?.aborted)
			return { ok: false, error: "bash_async start was cancelled before job acceptance." };
		if (this.shuttingDown) return { ok: false, error: "bash_async is shutting down and cannot accept new jobs." };
		this.evictTerminalJobs();
		if (this.jobs.size >= MAX_RETAINED_JOBS)
			return { ok: false, error: `bash_async can retain at most ${MAX_RETAINED_JOBS} active or queued jobs.` };

		const environment = snapshotEnvironment(input.context);
		const id = randomUUID();
		const queuedAt = this.now();
		const logPath = join(this.logsDirectory, safeSessionId(environment.PI_SESSION_ID), `${queuedAt}-${id}.log`);
		let resolveSettlement = () => {};
		const settled = new Promise<void>((resolve) => {
			resolveSettlement = resolve;
		});
		const logWriter = this.createLog(logPath);
		const job: ManagedJob = {
			id,
			status: "queued",
			title: titleFor(input.command, input.title),
			command: input.command,
			cwd: cwd.cwd,
			queuedAt,
			timeoutSeconds: input.timeoutSeconds,
			log: { path: logPath, bytes: 0, truncated: false },
			logWriter,
			abortController: new AbortController(),
			environment,
			resolveSettlement,
			settled,
			slotAcquired: false,
			finalized: false,
		};
		this.jobs.set(id, job);
		this.queue.push(id);
		this.emitStateChange(job);
		this.drain();
		return {
			ok: true,
			details: {
				jobId: id,
				status: job.status === "running" ? "running" : "queued",
				title: job.title,
				command: job.command,
				cwd: job.cwd,
				queuedAt: job.queuedAt,
				timeoutSeconds: job.timeoutSeconds,
				logPath,
			},
		};
	}

	get(jobId: string): BashAsyncJob | undefined {
		const job = this.jobs.get(jobId);
		return job ? this.publicJob(job) : undefined;
	}

	list(): BashAsyncJob[] {
		this.pruneExpiredJobs();
		return [...this.jobs.values()]
			.sort((left, right) => {
				const activeOrder = Number(isTerminalJobStatus(left.status)) - Number(isTerminalJobStatus(right.status));
				return activeOrder || right.queuedAt - left.queuedAt;
			})
			.map((job) => this.publicJob(job));
	}

	runningJobs(): BashAsyncJob[] {
		return [...this.jobs.values()]
			.filter((job) => job.status === "running")
			.sort(
				(left, right) =>
					(left.startedAt ?? left.queuedAt) - (right.startedAt ?? right.queuedAt) || left.queuedAt - right.queuedAt,
			)
			.map((job) => this.publicJob(job));
	}

	output(
		jobId: string,
		options: { lines?: number; outputOffset?: number; incremental?: boolean } = {},
	): JobOutputResult | undefined {
		const job = this.jobs.get(jobId);
		if (!job) return undefined;
		const output = job.logWriter.output(options);
		return { job: this.publicJob(job), ...output };
	}

	status(jobId: string): StatusResultDetails | undefined {
		const job = this.jobs.get(jobId);
		if (!job) return undefined;
		const log = job.logWriter.summary();
		return {
			jobId: job.id,
			status: job.status,
			queuedAt: job.queuedAt,
			startedAt: job.startedAt,
			endedAt: job.endedAt,
			runtimeMs: (job.endedAt ?? this.now()) - (job.startedAt ?? job.queuedAt),
			exitCode: job.exitCode,
			errorSummary: job.errorSummary,
			logPath: log.path,
			logBytes: log.bytes,
			logTruncated: log.truncated,
		};
	}

	async kill(jobId: string, graceMs = DEFAULT_KILL_GRACE_MS): Promise<KillResult> {
		const job = this.jobs.get(jobId);
		if (!job) return undefined;
		if (!isTerminalJobStatus(job.status)) {
			job.requestedCause = "kill";
			if (job.status === "queued") this.finalize(job, "kill");
			else job.abortController.abort();
		}
		if (!(await this.waitFor(job.settled, graceMs))) {
			this.quarantineUnsettledExecution(
				job,
				`Process termination could not be confirmed within ${graceMs} ms after abort.`,
			);
		}
		return this.get(jobId);
	}

	beginShutdown(): void {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.options.notifications?.suppress();
		for (const job of this.jobs.values()) {
			if (isTerminalJobStatus(job.status)) continue;
			job.requestedCause = "shutdown";
			if (job.status === "queued") this.finalize(job, "shutdown");
			else job.abortController.abort();
		}
	}

	async abortAndSettleAll({ graceMs = DEFAULT_KILL_GRACE_MS }: { graceMs?: number } = {}): Promise<void> {
		this.beginShutdown();
		const running = [...this.jobs.values()].filter((job) => job.status === "running");
		await this.waitFor(
			Promise.all(running.map((job) => job.settled)).then(() => undefined),
			graceMs,
		);
		for (const job of running) {
			if (isTerminalJobStatus(job.status)) continue;
			this.detachTimedOutJob(job);
		}
	}

	closeAllLogs(): void {
		for (const job of this.jobs.values()) this.closeLog(job.logWriter);
	}

	private drain(): void {
		while (!this.shuttingDown && this.running < this.maxConcurrency && this.queue.length > 0) {
			const id = this.queue.shift();
			if (!id) continue;
			const job = this.jobs.get(id);
			if (job?.status !== "queued") continue;
			job.status = "running";
			job.startedAt = this.now();
			job.slotAcquired = true;
			this.running++;
			this.emitStateChange(job);
			const executionJob: ExecutionJob = {
				id: job.id,
				command: job.command,
				cwd: job.cwd,
				timeoutSeconds: job.timeoutSeconds,
				abortController: job.abortController,
				environment: job.environment,
			};
			const bridge: ExecutionBridge = {
				onData: (data) => this.appendJobData(job, bridge, data),
				settle: (outcome) => this.settle(job, outcome),
			};
			job.executionBridge = bridge;
			job.execution = runExecution(executionJob, this.executeAdapter, bridge);
			void job.execution.catch(() => {});
		}
	}

	private settle(job: ManagedJob, outcome: ExecutionOutcome): void {
		if (outcome.error !== undefined) {
			const summary = errorSummary(outcome.error);
			const exitCode = summary.match(/Command exited with code (\d+)/)?.[1];
			this.finalize(
				job,
				causeForError(outcome.error, job.requestedCause),
				exitCode ? Number(exitCode) : undefined,
				summary,
			);
			return;
		}
		if (outcome.exitCode === null) {
			this.finalize(job, job.requestedCause ?? "spawn_error", null, "Command exited without an exit code.");
			return;
		}
		this.finalize(job, outcome.exitCode === 0 ? "natural" : "nonzero", outcome.exitCode);
	}

	private finalize(job: ManagedJob, cause: JobTerminalCause, exitCode?: number | null, error?: string): boolean {
		if (job.finalized) return false;
		job.finalized = true;
		job.terminalCause = job.requestedCause ?? cause;
		job.status = terminalStatusForCause(job.terminalCause);
		job.endedAt = this.now();
		job.exitCode = exitCode;
		job.errorSummary = error;
		this.clearSettlementTimer(job);
		const log = job.logWriter.summary();
		job.log = { path: log.path, bytes: log.bytes, truncated: log.truncated };
		const logClosed = this.closeLog(job.logWriter);
		if (logClosed) this.scheduleLogMaintenance(log.path);
		if (job.slotAcquired) {
			job.slotAcquired = false;
			this.running--;
		}
		this.emitStateChange(job);
		job.resolveSettlement();
		this.detachExecution(job);
		if (!this.shuttingDown)
			this.options.notifications?.enqueue({
				...this.publicJob(job),
				tail: job.logWriter.tail(20),
			} satisfies CompletedJob);
		this.drain();
		return true;
	}

	private detachTimedOutJob(job: ManagedJob): void {
		job.settlementTimedOut = true;
		job.finalized = true;
		job.terminalCause = job.requestedCause ?? "shutdown";
		job.status = terminalStatusForCause(job.terminalCause);
		job.endedAt = this.now();
		const log = job.logWriter.summary();
		job.log = { path: log.path, bytes: log.bytes, truncated: log.truncated };
		const logClosed = this.closeLog(job.logWriter);
		if (logClosed) this.scheduleLogMaintenance(log.path);
		if (job.slotAcquired) {
			job.slotAcquired = false;
			this.running--;
		}
		this.emitStateChange(job);
		job.resolveSettlement();
		this.clearSettlementTimer(job);
		this.detachExecution(job);
		this.jobs.delete(job.id);
	}

	private appendJobData(job: ManagedJob, bridge: ExecutionBridge, data: Buffer): void {
		if (bridge.logError !== undefined) return;
		try {
			job.logWriter.append(data);
		} catch (error) {
			bridge.logError = new Error(`bash_async log write failed: ${errorSummary(error)}`);
			try {
				job.logWriter.seal();
			} catch {
				// The failing log is sealed best-effort. Never throw through a child stream callback.
			}
			job.abortController.abort();
			this.scheduleUnsettledAbortQuarantine(job, "Output logging failed and process termination was not confirmed.");
		}
	}

	private scheduleUnsettledAbortQuarantine(job: ManagedJob, error: string): void {
		if (job.settlementTimer || job.finalized) return;
		job.settlementTimer = setTimeout(() => {
			job.settlementTimer = undefined;
			this.quarantineUnsettledExecution(job, error);
		}, this.settlementGraceMs);
		job.settlementTimer.unref?.();
	}

	private quarantineUnsettledExecution(job: ManagedJob, error: string): void {
		if (job.finalized) return;
		job.settlementTimedOut = true;
		job.finalized = true;
		job.terminalCause = "cleanup_error";
		job.status = "failed";
		job.endedAt = this.now();
		job.errorSummary = error;
		this.clearSettlementTimer(job);
		const log = job.logWriter.summary();
		job.log = { path: log.path, bytes: log.bytes, truncated: log.truncated };
		const logClosed = this.closeLog(job.logWriter);
		if (logClosed) this.scheduleLogMaintenance(log.path);
		const quarantinedSlot = job.slotAcquired;
		job.slotAcquired = false;
		this.emitStateChange(job);
		job.resolveSettlement();
		this.detachExecution(job, () => {
			if (!quarantinedSlot) return;
			this.running--;
			this.drain();
		});
		if (!this.shuttingDown)
			this.options.notifications?.enqueue({
				...this.publicJob(job),
				tail: job.logWriter.tail(20),
			} satisfies CompletedJob);
	}

	private clearSettlementTimer(job: ManagedJob): void {
		if (job.settlementTimer) clearTimeout(job.settlementTimer);
		job.settlementTimer = undefined;
	}

	private detachExecution(job: ManagedJob, onLateSettlement?: () => void): void {
		const bridge = job.executionBridge;
		if (bridge) {
			let lateSettlementHandled = false;
			bridge.onData = () => {};
			bridge.settle = () => {
				if (lateSettlementHandled) return;
				lateSettlementHandled = true;
				onLateSettlement?.();
			};
			bridge.logError = undefined;
		}
		job.executionBridge = undefined;
		job.execution = undefined;
	}

	private closeLog(logWriter: JobLog): boolean {
		try {
			logWriter.close();
			return logWriter.summary().closed;
		} catch {
			// Log cleanup is best-effort and must never terminate the Pi host.
			return false;
		}
	}

	private emitStateChange(job: ManagedJob): void {
		try {
			this.options.onStateChange?.(this.publicJob(job));
		} catch {
			// UI observers are best-effort and must never disrupt job lifecycle management.
		}
	}

	private publicJob(job: ManagedJob): BashAsyncJob {
		const log = job.logWriter.summary();
		return {
			id: job.id,
			status: job.status,
			title: job.title,
			command: job.command,
			cwd: job.cwd,
			queuedAt: job.queuedAt,
			startedAt: job.startedAt,
			endedAt: job.endedAt,
			timeoutSeconds: job.timeoutSeconds,
			log: { path: log.path, bytes: log.bytes, truncated: log.truncated },
			exitCode: job.exitCode,
			errorSummary: job.errorSummary,
			terminalCause: job.terminalCause,
		};
	}

	private evictTerminalJobs(): void {
		this.pruneExpiredJobs();
		while (this.jobs.size >= MAX_RETAINED_JOBS) {
			const terminal = [...this.jobs.values()]
				.filter((job) => isTerminalJobStatus(job.status))
				.sort((left, right) => (left.endedAt ?? left.queuedAt) - (right.endedAt ?? right.queuedAt))[0];
			if (!terminal) return;
			this.jobs.delete(terminal.id);
		}
	}

	private pruneExpiredJobs(): void {
		const deadline = this.now() - COMPLETED_JOB_TTL_MS;
		for (const [id, job] of this.jobs) {
			if (isTerminalJobStatus(job.status) && (job.endedAt ?? 0) < deadline) this.jobs.delete(id);
		}
	}

	private scheduleLogMaintenance(closedLogPath?: string): void {
		this.logMaintenance = this.logMaintenance
			.then(async () => {
				if (closedLogPath) await this.markLogClosed(closedLogPath);
				await this.cleanupOldLogs();
				await this.enforceClosedLogQuota();
			})
			.catch(() => {
				// Log retention is best-effort and must never disrupt job completion.
			});
	}

	private async markLogClosed(logPath: string): Promise<void> {
		try {
			const log = await stat(logPath);
			if (!log.isFile()) return;
			await writeFile(this.closedMarkerPath(logPath), "", { flag: "wx", mode: 0o600 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}

	private async cleanupOldLogs(): Promise<void> {
		try {
			const deadline = this.now() - COMPLETED_JOB_TTL_MS;
			const sessions = await readdir(this.logsDirectory, { withFileTypes: true });
			for (const session of sessions) {
				if (!session.isDirectory()) continue;
				const sessionDirectory = join(this.logsDirectory, session.name);
				const logs = await this.listClosedLogsInDirectory(sessionDirectory);
				for (const log of logs) {
					if (log.mtimeMs >= deadline) continue;
					await this.onBeforeStaleLogRemove?.(log.path);
					await this.removeClosedLog(log.path, deadline);
				}
				// Never recursively remove a session directory. A concurrently accepted job may
				// have created a fresh log after the directory scan; rmdir then safely fails.
				await rmdir(sessionDirectory).catch(() => {});
			}
		} catch {
			// The directory is absent on first use and cleanup is best-effort.
		}
	}

	private async enforceClosedLogQuota(): Promise<void> {
		const logs = await this.listClosedLogs();
		let retainedBytes = logs.reduce((total, log) => total + log.bytes, 0);
		for (const log of logs.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
			if (retainedBytes <= this.maxClosedLogBytes) return;
			const removedBytes = await this.removeClosedLog(log.path);
			if (removedBytes !== undefined) retainedBytes -= removedBytes;
		}
	}

	private async listClosedLogs(): Promise<ClosedLog[]> {
		try {
			const sessions = await readdir(this.logsDirectory, { withFileTypes: true });
			const logs: ClosedLog[] = [];
			for (const session of sessions) {
				if (session.isDirectory())
					logs.push(...(await this.listClosedLogsInDirectory(join(this.logsDirectory, session.name))));
			}
			return logs;
		} catch {
			return [];
		}
	}

	private async listClosedLogsInDirectory(sessionDirectory: string): Promise<ClosedLog[]> {
		try {
			const entries = await readdir(sessionDirectory, { withFileTypes: true });
			const logs: ClosedLog[] = [];
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
				const log = await this.readClosedLog(join(sessionDirectory, entry.name));
				if (log) logs.push(log);
			}
			return logs;
		} catch {
			return [];
		}
	}

	private async readClosedLog(logPath: string): Promise<ClosedLog | undefined> {
		if (this.activeLogPaths().has(logPath)) return undefined;
		const markerPath = this.closedMarkerPath(logPath);
		try {
			const [log, marker] = await Promise.all([stat(logPath), stat(markerPath)]);
			if (!log.isFile() || !marker.isFile()) return undefined;
			return { path: logPath, markerPath, bytes: log.size, mtimeMs: log.mtimeMs };
		} catch {
			return undefined;
		}
	}

	private async removeClosedLog(logPath: string, staleDeadline?: number): Promise<number | undefined> {
		const log = await this.readClosedLog(logPath);
		if (!log || (staleDeadline !== undefined && log.mtimeMs >= staleDeadline)) return undefined;
		await rm(log.path, { force: true });
		await rm(log.markerPath, { force: true });
		return log.bytes;
	}

	private activeLogPaths(): Set<string> {
		return new Set(
			[...this.jobs.values()].filter((job) => !isTerminalJobStatus(job.status)).map((job) => job.logWriter.path),
		);
	}

	private closedMarkerPath(logPath: string): string {
		return `${logPath}${CLOSED_LOG_MARKER_SUFFIX}`;
	}

	private async waitFor(promise: Promise<void>, graceMs: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = await Promise.race([
			promise.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), graceMs);
			}),
		]);
		if (timer) clearTimeout(timer);
		return settled;
	}
}

function snapshotEnvironment(context: ExtensionContext): SessionEnvironment {
	const model = context.model;
	const sessionFile = context.sessionManager.getSessionFile();
	return {
		PI_SESSION_ID: context.sessionManager.getSessionId(),
		...(sessionFile ? { PI_SESSION_FILE: sessionFile } : {}),
		...(model ? { PI_PROVIDER: model.provider, PI_MODEL: model.id } : {}),
		...(context.thinkingLevel ? { PI_REASONING_LEVEL: context.thinkingLevel } : {}),
	};
}
