/** biome-ignore-all lint/suspicious/noExplicitAny: external Pi context and EventBus host fixtures. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncTaskProvider } from "./async-task-provider.js";
import { COMPLETED_JOB_TTL_MS, JobManager } from "./job-manager.js";
import { NotificationBatcher } from "./notification-batcher.js";

let validateWire: ((frame: unknown) => unknown) | undefined;
beforeAll(async () => {
	const root = process.env.PICKY_CONTRACT_ROOT;
	if (!root) {
		if (process.env.PICKY_CONTRACT_REQUIRED === "1") throw new Error("PICKY_CONTRACT_ROOT is required");
		return;
	}
	const wire = await import(
		/* @vite-ignore */ pathToFileURL(join(root, "agentd/src/domain/async-task-contract.ts")).href
	);
	validateWire = (frame) => wire.AsyncTaskHostMessageSchema.parse(frame);
});

let directory: string;
let provider: AsyncTaskProvider;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "bash-hosted-"));
	vi.useFakeTimers();
});
afterEach(async () => {
	provider?.shutdown();
	vi.useRealTimers();
	await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
});
function setup(validateCwd = async () => ({ ok: true as const, cwd: directory }), discover = true) {
	const frames: any[] = [];
	const listeners = new Set<(frame: any) => void>();
	let owner: any;
	let automatic = true;
	const bus = {
		on: (_name: string, callback: (frame: any) => void) => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
		emit: (_name: string, frame: any) => {
			validateWire?.(frame);
			frames.push(structuredClone(frame));
			for (const listener of listeners) listener(frame);
			if (frame.type === "host-query" && discover) {
				owner = {
					sessionId: "session",
					runtimeInstanceId: "runtime",
					piSessionId: frame.piSessionId,
					providerId: frame.providerId,
					providerInstanceId: frame.providerInstanceId,
				};
				reply({
					type: "host-state",
					requestId: frame.requestId,
					supported: true,
					admissionState: "open",
					capabilities: {
						registration: true,
						snapshot: true,
						cancel: true,
						detail: true,
						closeAdmission: true,
						suppressDelivery: true,
					},
				});
			}
			if (frame.type === "task-register" && automatic) approve(frame);
			if (frame.type === "registration-abandon")
				reply({
					type: "task-register-result",
					requestId: frame.requestId,
					taskId: frame.taskId,
					registration: "abandoned",
					outcome: "settled",
				});
		},
	};
	const reply = (fields: any) =>
		bus.emit("pi.async-tasks.v1", {
			contract: "pi.async-tasks.v1",
			...owner,
			requestId: "control",
			providerRevision: 0,
			controlGeneration: 0,
			...fields,
		});
	const approve = (frame: any) =>
		reply({
			type: "task-register-result",
			requestId: frame.requestId,
			taskId: frame.task.taskId,
			grantId: "grant",
			controlGeneration: frame.task.controlGeneration,
			registration: "approved",
			outcome: "accepted",
		});
	const send = vi.fn();
	const notifications = new NotificationBatcher({
		deliveryState: (id) => provider.deliveryState(id),
		send: (message) => provider.deliver(message.details.jobIds, message, send),
	});
	const completions: Array<(result: { exitCode: number }) => void> = [];
	const execute = vi.fn(() => new Promise<{ exitCode: number }>((resolve) => completions.push(resolve)));
	provider = new AsyncTaskProvider(
		bus,
		"bash-async",
		"0.2.1",
		{
			cancel: async (id) => {
				await manager.kill(id, 10);
			},
			detail: (id) => manager.output(id)?.text,
			close: () => {
				notifications.suppress();
				manager.closeAdmission();
			},
			deliveryResumed: () => notifications.flush(),
			reopen: () => {
				notifications.resume();
				manager.reopenAdmission();
			},
		},
		30,
	);
	provider.bind("pi-session");
	const manager = new JobManager({
		provider,
		execute,
		notifications,
		logsDirectory: directory,
		maxConcurrency: 1,
		validateCwd,
	});
	const context = {
		cwd: directory,
		sessionManager: { getSessionId: () => "pi-session", getSessionFile: () => undefined },
	} as any;
	const start = () => manager.start({ command: "offline", context, timeoutSeconds: 0 });
	const detail = () => frames.filter((frame) => frame.type === "task-update").at(-1)?.detail;
	return {
		manager,
		start,
		execute,
		completions,
		frames,
		send,
		approve,
		reply,
		detail,
		enableDiscovery: () => {
			discover = true;
		},
		manual: () => {
			automatic = false;
		},
	};
}

describe("hosted bash manager lifecycle", () => {
	it.each([
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	])("rejects discovery continuation after session switch (return=%s, supported=%s)", async (returns, supported) => {
		const { start, frames, execute, enableDiscovery } = setup(undefined, false);
		const pending = start();
		await vi.advanceTimersByTimeAsync(0);
		if (supported) enableDiscovery();
		provider.bind("foreign");
		if (returns) provider.bind("pi-session");
		expect((await pending).ok).toBe(false);
		expect(frames.filter((frame) => frame.type === "task-register")).toHaveLength(0);
		expect(execute).not.toHaveBeenCalled();
	});

	it("automatically replays the original held batch once on origin return", async () => {
		const { start, completions, send, detail, reply } = setup();
		await start();
		await start();
		completions[0]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(0);
		completions[1]({ exitCode: 7 });
		await vi.advanceTimersByTimeAsync(0);
		const ids = detail().tickets.map((ticket: any) => ticket.completionId);
		expect(() => provider.bind("foreign")).toThrow();
		await vi.advanceTimersByTimeAsync(500);
		expect(send).not.toHaveBeenCalled();
		provider.bind("pi-session");
		expect(send).toHaveBeenCalledOnce();
		const message = send.mock.calls[0][0];
		expect(message.content).toContain("exit 7");
		expect(message.details.asyncTasks).toMatchObject({
			piSessionId: "pi-session",
			completionIds: ids,
			controlGeneration: 0,
		});
		reply({ type: "completion-observed", deliveryId: message.details.asyncTasks.deliveryId, completionIds: ids });
		provider.bind("foreign");
		provider.bind("pi-session");
		await vi.advanceTimersByTimeAsync(1000);
		expect(send).toHaveBeenCalledOnce();
	});

	it("omits a discarded job without losing another held result", async () => {
		const { start, completions, send } = setup();
		const first = await start();
		const second = await start();
		if (!first.ok || !second.ok) throw new Error("fixture admission failed");
		completions[0]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(0);
		completions[1]({ exitCode: 7 });
		await vi.advanceTimersByTimeAsync(0);
		expect(() => provider.bind("foreign")).toThrow();
		await vi.advanceTimersByTimeAsync(500);
		provider.discardPending(first.details.jobId);
		provider.bind("pi-session");
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0][0].details.jobIds).toEqual([second.details.jobId]);
		expect(send.mock.calls[0][0].content).not.toContain(first.details.jobId);
	});

	it("does not retry a possibly submitted result after a send exception", async () => {
		const { start, completions, send } = setup();
		await start();
		send.mockImplementation(() => {
			throw new Error("submission uncertain");
		});
		completions[0]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(500);
		expect(() => provider.bind("foreign")).toThrow();
		provider.bind("pi-session");
		await vi.advanceTimersByTimeAsync(500);
		expect(send).toHaveBeenCalledOnce();
	});

	it.each(["close", "shutdown", "discard"])("does not replay a held result after %s", async (action) => {
		const { start, completions, send, reply } = setup();
		const result = await start();
		if (!result.ok) throw new Error(result.error);
		completions[0]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(0);
		expect(() => provider.bind("foreign")).toThrow();
		await vi.advanceTimersByTimeAsync(500);
		if (action === "close")
			reply({ type: "control-request", action: "closeAdmission", deliveryIds: [], controlGeneration: 1 });
		else if (action === "shutdown") provider.shutdown();
		else provider.discardPending(result.details.jobId);
		provider.bind("pi-session");
		await vi.advanceTimersByTimeAsync(1000);
		expect(send).not.toHaveBeenCalled();
	});

	it("rejects an unaccepted start paused in cwd validation after a failed foreign switch", async () => {
		let release!: () => void;
		let validations = 0;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { start, frames, execute, completions, send, detail } = setup(async () => {
			if (++validations === 2) await gate;
			return { ok: true, cwd: directory };
		});
		expect((await start()).ok).toBe(true);
		const count = frames.filter((frame) => frame.type === "task-register").length;
		const stale = start();
		expect(() => provider.bind("foreign")).toThrow();
		release();
		expect((await stale).ok).toBe(false);
		expect(frames.filter((frame) => frame.type === "task-register")).toHaveLength(count);
		completions[0]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(500);
		expect(execute).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
		expect(detail()).toMatchObject({
			tasks: [{ piSessionId: "pi-session", execution: "succeeded", presence: "settled" }],
			tickets: [{ state: "pending" }],
		});
		provider.bind("pi-session");
		expect((await start()).ok).toBe(true);
		completions[1]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(500);
	});

	it("rejects an unaccepted grant after a switch away and back", async () => {
		const { manual, start, frames, approve, execute } = setup();
		manual();
		const pending = start();
		await vi.advanceTimersByTimeAsync(0);
		expect(() => provider.bind("foreign")).toThrow();
		provider.bind("pi-session");
		approve(frames.find((frame) => frame.type === "task-register"));
		expect((await pending).ok).toBe(false);
		expect(execute).not.toHaveBeenCalled();
	});

	it("does not enter the manager queue until the grant arrives", async () => {
		const { manual, start, manager, frames, approve, execute, completions } = setup();
		manual();
		const pending = start();
		await vi.advanceTimersByTimeAsync(0);
		expect(manager.list()).toEqual([]);
		expect(execute).not.toHaveBeenCalled();
		approve(frames.find((frame) => frame.type === "task-register"));
		const result = await pending;
		expect(result.ok).toBe(true);
		expect(execute).toHaveBeenCalledOnce();
		completions[0]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(0);
	});

	it("keeps a ticket through the 500ms batch and read-only status/output queries", async () => {
		const { start, manager, completions, detail, send } = setup();
		const result = await start();
		if (!result.ok) throw new Error(result.error);
		completions[0]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(0);
		expect(detail()).toMatchObject({
			tasks: [{ execution: "succeeded", presence: "settled" }],
			tickets: [{ state: "pending" }],
		});
		manager.status(result.details.jobId);
		manager.output(result.details.jobId);
		manager.list();
		await vi.advanceTimersByTimeAsync(499);
		expect(send).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0][0].details).toMatchObject({
			jobIds: [result.details.jobId],
			asyncTasks: { taskIds: [result.details.jobId] },
		});
		vi.setSystemTime(Date.now() + COMPLETED_JOB_TTL_MS + 1);
		expect(manager.list()).toHaveLength(1);
	});

	it("retains cleanup_error and accepts late settlement without rewriting the failed result", async () => {
		const { start, manager, completions, detail } = setup();
		const result = await start();
		if (!result.ok) throw new Error(result.error);
		const killed = manager.kill(result.details.jobId, 10);
		await vi.advanceTimersByTimeAsync(10);
		await killed;
		expect(detail().tasks[0]).toMatchObject({ execution: "failed", presence: "unknown" });
		vi.setSystemTime(Date.now() + COMPLETED_JOB_TTL_MS + 1);
		expect(manager.list()).toHaveLength(1);
		completions[0]({ exitCode: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(detail().tasks[0]).toMatchObject({ execution: "failed", presence: "settled" });
	});

	it("does not start a queued job after close admission, even when the running job exits", async () => {
		const { start, reply, execute, completions, send, detail } = setup();
		await start();
		await start();
		expect(execute).toHaveBeenCalledOnce();
		reply({ type: "control-request", action: "closeAdmission", deliveryIds: [], controlGeneration: 1 });
		completions[0]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(execute).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
		expect(detail().tasks.every((task: any) => task.presence === "settled")).toBe(true);
	});

	it("preserves shutdown tombstones and the eventual resource exit observer", async () => {
		const { start, manager, completions, detail } = setup();
		await start();
		provider.shutdown();
		const shutdown = manager.abortAndSettleAll({ graceMs: 10 });
		await vi.advanceTimersByTimeAsync(10);
		await shutdown;
		expect(detail().tasks[0].presence).toBe("unknown");
		expect(manager.list()).toHaveLength(1);
		completions[0]({ exitCode: 1 });
		await vi.advanceTimersByTimeAsync(0);
		expect(detail().tasks[0].presence).toBe("settled");
	});
	it("merges multiple completion IDs into one delayed batch", async () => {
		const { start, completions, send } = setup();
		await start();
		await start();
		completions[0]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(0);
		completions[1]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(500);
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0][0].details.asyncTasks.completionIds).toHaveLength(2);
		expect(send.mock.calls[0][0].details.asyncTasks.taskIds).toHaveLength(2);
	});

	it("allows only new-generation delivery after an explicit host reopen", async () => {
		const { start, completions, send, reply } = setup();
		await start();
		reply({ type: "control-request", action: "closeAdmission", deliveryIds: [], controlGeneration: 1 });
		completions[0]({ exitCode: 1 });
		await vi.advanceTimersByTimeAsync(500);
		expect(send).not.toHaveBeenCalled();
		reply({
			type: "host-state",
			supported: true,
			admissionState: "open",
			controlGeneration: 2,
			capabilities: {
				registration: true,
				snapshot: true,
				cancel: true,
				detail: true,
				closeAdmission: true,
				suppressDelivery: true,
			},
		});
		await start();
		completions[1]({ exitCode: 0 });
		await vi.advanceTimersByTimeAsync(500);
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0][0].details.asyncTasks.controlGeneration).toBe(2);
	});
});
