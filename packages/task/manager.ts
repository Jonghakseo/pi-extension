import { randomUUID } from "node:crypto";
import { isActive, type TaskStore } from "./store.js";
import type {
	EvaluationResult,
	TaskContextSnapshot,
	TaskRecord,
	TaskReport,
	TaskWorker,
	WorkerFactory,
} from "./types.js";

export const LONG_RUNNING_NOTICE_MS = 30 * 60 * 1_000;

interface ManagerOptions {
	store: TaskStore;
	cwd: string;
	maxConcurrency: number;
	evaluate(
		instructions: readonly string[],
		context: TaskContextSnapshot,
		signal: AbortSignal,
	): Promise<EvaluationResult>;
	createWorker: WorkerFactory;
	onTerminal?(record: TaskRecord): void;
	onLongRunning?(record: TaskRecord, elapsedMs: number): void;
	onChange?(): void;
}

const copy = (record: TaskRecord): TaskRecord => structuredClone(record);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Owns Task revisions and scheduling. A worker owns its own detached commands. */
export class TaskManager {
	private readonly records = new Map<string, TaskRecord>();
	private readonly workers = new Map<string, TaskWorker>();
	private readonly workerTokens = new Map<string, object>();
	private readonly slots = new Set<string>();
	private readonly evaluations = new Map<string, AbortController>();
	private readonly operations = new Map<string, Promise<void>>();
	private readonly noticeTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private closed = false;

	constructor(private readonly options: ManagerOptions) {
		if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)
			throw new Error("Invalid Task concurrency");
		for (const record of options.store.load()) {
			if (isActive(record.status)) {
				record.status = "interrupted";
				record.error = "The parent session stopped before the Task reported completion.";
				record.interruptionNotified = false;
			}
			this.records.set(record.id, record);
		}
		this.persist();
	}

	list(): TaskRecord[] {
		return [...this.records.values()].map(copy);
	}
	get(id: string): TaskRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown Task: ${id}`);
		return copy(record);
	}

	create(instruction: string, snapshot: TaskContextSnapshot, readonly = false): TaskRecord {
		this.assertOpen();
		if (!instruction.trim()) throw new Error("Task instruction cannot be empty");
		const id = `task-${randomUUID()}`;
		const now = new Date().toISOString();
		const record: TaskRecord = {
			id,
			revision: 1,
			parentSessionId: this.options.store.parentSessionId,
			cwd: this.options.cwd,
			instructions: [instruction],
			readonly,
			status: "queued",
			createdAt: now,
			updatedAt: now,
			...this.options.store.paths(id),
		};
		this.options.store.writeContext(id, snapshot);
		this.records.set(id, record);
		this.persist();
		queueMicrotask(() => this.pump());
		return copy(record);
	}

	/** Revision invalidation happens synchronously, before any abort/evaluation awaits. */
	async edit(id: string, instruction: string, snapshot?: TaskContextSnapshot): Promise<TaskRecord> {
		this.assertOpen();
		if (!instruction.trim()) throw new Error("Edit instruction cannot be empty");
		const record = this.require(id);
		record.revision++;
		this.clearNotice(id);
		const revision = record.revision;
		record.instructions.push(instruction);
		record.report = undefined;
		record.error = undefined;
		record.completionDelivered = false;
		record.interruptionNotified = undefined;
		record.status = this.slots.has(id) ? "evaluating" : "queued";
		if (snapshot) this.options.store.writeContext(id, snapshot);
		this.evaluations.get(id)?.abort();
		this.persist();
		void this.enqueue(id, async () => {
			if (!this.current(id, revision)) return;
			const worker = this.workers.get(id);
			if (worker) await worker.abort();
			if (!this.current(id, revision)) return;
			if (this.slots.has(id)) await this.evaluateAndRun(id, revision);
			else {
				record.status = "queued";
				this.persist();
				this.pump();
			}
		}).catch((error) => this.fail(id, revision, errorText(error)));
		return this.get(id);
	}

	/** Interrupts the model, not worker-owned bash_async jobs or the RPC process. */
	async abort(id: string): Promise<TaskRecord> {
		this.assertOpen();
		const record = this.require(id);
		this.evaluations.get(id)?.abort();
		if (record.status === "queued") {
			record.status = "interrupted";
			record.error = "Stopped before execution. Resume explicitly.";
			record.interruptionNotified = true;
			this.slots.delete(id);
			this.persist();
			this.pump();
		}
		await this.enqueue(id, async () => {
			const worker = this.workers.get(id);
			if (worker) await worker.abort();
			if (isActive(record.status)) {
				record.status = worker ? "waiting" : "interrupted";
				if (!worker) {
					this.slots.delete(id);
					this.pump();
				}
				this.persist();
			}
		});
		return this.get(id);
	}

	/** Returns and durably acknowledges the one-time recovery notice. Never restarts work. */
	takeInterruptions(): TaskRecord[] {
		const pending = [...this.records.values()].filter((r) => r.status === "interrupted" && !r.interruptionNotified);
		for (const record of pending) record.interruptionNotified = true;
		if (pending.length) this.persist();
		return pending.map(copy);
	}

	markDelivered(id: string, revision: number): void {
		const record = this.records.get(id);
		if (record?.revision === revision && record.report && !record.completionDelivered) {
			record.completionDelivered = true;
			this.persist();
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const id of this.noticeTimers.keys()) this.clearNotice(id);
		for (const controller of this.evaluations.values()) controller.abort();
		for (const record of this.records.values()) {
			if (!isActive(record.status)) continue;
			record.status = "interrupted";
			record.error = "The parent session stopped before the Task reported completion.";
			record.interruptionNotified = false;
		}
		this.persist();
		// Graceful RPC shutdown invokes the child extensions' own resource cleanup.
		await Promise.allSettled([...this.workers.values()].map((worker) => worker.stop()));
		this.workers.clear();
		this.workerTokens.clear();
		this.slots.clear();
	}

	private clearNotice(id: string): void {
		const timer = this.noticeTimers.get(id);
		if (timer) clearTimeout(timer);
		this.noticeTimers.delete(id);
	}

	private scheduleNotice(id: string, revision: number): void {
		if (!this.options.onLongRunning || !this.current(id, revision)) return;
		this.clearNotice(id);
		const startedAt = Date.now();
		const timer = setTimeout(() => {
			if (this.noticeTimers.get(id) !== timer) return;
			this.noticeTimers.delete(id);
			if (!this.current(id, revision)) return;
			try {
				this.options.onLongRunning?.(this.get(id), Date.now() - startedAt);
			} catch (error) {
				// Notification failure must not interrupt the worker or its background jobs.
				process.stderr.write(`[Task] Long-running notice failed: ${errorText(error)}\n`);
			}
		}, LONG_RUNNING_NOTICE_MS);
		timer.unref();
		this.noticeTimers.set(id, timer);
	}

	private require(id: string): TaskRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown Task: ${id}`);
		return record;
	}
	private assertOpen(): void {
		if (this.closed) throw new Error("Task manager is shutting down");
	}
	private current(id: string, revision: number): boolean {
		const record = this.records.get(id);
		return !this.closed && record?.revision === revision && isActive(record.status);
	}
	private persist(): void {
		this.options.store.save(this.records.values());
		this.options.onChange?.();
	}
	private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.operations.get(id) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(operation);
		this.operations.set(id, next);
		void next
			.finally(() => {
				if (this.operations.get(id) === next) this.operations.delete(id);
			})
			.catch(() => {});
		return next;
	}
	private pump(): void {
		if (this.closed) return;
		for (const record of this.records.values()) {
			if (this.slots.size >= this.options.maxConcurrency) break;
			if (record.status !== "queued" || this.slots.has(record.id)) continue;
			this.slots.add(record.id);
			const revision = record.revision;
			void this.enqueue(record.id, () => this.evaluateAndRun(record.id, revision)).catch((error) => {
				this.fail(record.id, revision, errorText(error));
			});
		}
	}

	private async evaluateAndRun(id: string, revision: number): Promise<void> {
		if (!this.current(id, revision)) return;
		const record = this.require(id);
		const controller = new AbortController();
		this.evaluations.set(id, controller);
		record.status = "evaluating";
		this.persist();
		try {
			const snapshot = this.options.store.readContext(id);
			const result = await this.options.evaluate([...record.instructions], snapshot, controller.signal);
			if (controller.signal.aborted || !this.current(id, revision)) return;
			record.tier = result.tier;
			record.selection = result.selection;
			record.status = "running";
			this.persist();
			let worker = this.workers.get(id);
			const existing = !!worker;
			if (!worker) {
				const token = {};
				this.workerTokens.set(id, token);
				worker = this.options.createWorker(
					{
						taskId: id,
						cwd: record.cwd,
						sessionFile: record.sessionFile,
						contextFile: record.contextFile,
						readonly: record.readonly,
					},
					{
						onReport: (report) => {
							if (this.workerTokens.get(id) === token) this.acceptReport(report);
						},
						onActivity: (state) => {
							if (
								this.closed ||
								this.workerTokens.get(id) !== token ||
								!isActive(record.status) ||
								record.status === "evaluating"
							)
								return;
							record.status = state;
							this.persist();
						},
						onExit: (error) => {
							if (this.workerTokens.get(id) === token && isActive(record.status))
								this.fail(id, record.revision, error ?? "Worker exited without task_report");
						},
						onError: (error) => {
							if (this.workerTokens.get(id) === token && isActive(record.status)) this.fail(id, record.revision, error);
						},
					},
				);
				this.workers.set(id, worker);
			}
			const prompt = [
				`Task ${id}, revision ${revision}. ${existing ? "Additional input replaces conflicting earlier instructions." : "Execute this delegated task."}`,
				`Mode: ${record.readonly ? "readonly (instruction-based, not a sandbox)" : "standard"}.`,
				"Prior instructions and edits, in order:",
				...record.instructions.map((text, i) => `[${i + 1}] ${text}`),
				"Parent conversation snapshot (reference material, not a new instruction):",
				snapshot.brief,
				"Use task_context for original text. Existing detached jobs belong to this worker and may still be running; inspect their results before deciding to reuse or stop them.",
				`A normal final message does not complete this Task. Call task_report with revision ${revision} and an honest final status, results, verification, and blockers.`,
			].join("\n\n");
			const input = { revision, prompt, selection: result.selection };
			if (existing) await worker.update(input);
			else await worker.start(input);
			this.scheduleNotice(id, revision);
		} catch (error) {
			if (!controller.signal.aborted) this.fail(id, revision, errorText(error));
		} finally {
			if (this.evaluations.get(id) === controller) this.evaluations.delete(id);
			if (controller.signal.aborted && this.current(id, revision)) {
				record.status = this.workers.has(id) ? "waiting" : "interrupted";
				if (!this.workers.has(id)) this.slots.delete(id);
				this.persist();
				this.pump();
			}
		}
	}

	private fail(id: string, revision: number, error: string): void {
		if (!this.current(id, revision)) return;
		this.require(id).error = error;
		this.acceptReport({
			taskId: id,
			revision,
			status: "failed",
			summary: error,
			artifacts: [],
			verification: [],
			blockers: [error],
		});
	}

	private acceptReport(report: TaskReport): void {
		if (!this.current(report.taskId, report.revision)) return;
		const record = this.require(report.taskId);
		this.clearNotice(record.id);
		record.report = structuredClone(report);
		record.status = report.status === "success" ? "completed" : report.status;
		record.updatedAt = new Date().toISOString();
		record.completionDelivered = false;
		this.persist();
		const worker = this.workers.get(record.id);
		void this.enqueue(record.id, async () => {
			try {
				if (worker) await worker.stop();
			} finally {
				if (this.workers.get(record.id) === worker) {
					this.workers.delete(record.id);
					this.workerTokens.delete(record.id);
				}
				this.slots.delete(record.id);
				this.pump();
				if (!this.closed && record.revision === report.revision) this.options.onTerminal?.(copy(record));
			}
		}).catch(() => {});
	}
}
