import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LONG_RUNNING_NOTICE_MS, TaskManager } from "./manager.js";
import { TaskStore } from "./store.js";
import type { EvaluationResult, TaskReport, TaskWorker, WorkerEvents, WorkerInput, WorkerOptions } from "./types.js";

const roots: string[] = [];
const managers: TaskManager[] = [];
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.useRealTimers();
});
const snapshot = {
	brief: "Keep the public API compatible.",
	entries: [{ ref: "#goal", role: "user", text: "Keep the public API compatible." }],
};
const choice: EvaluationResult = {
	tier: "balanced",
	selection: { provider: "test", model: "balanced", thinking: "medium" },
	evaluator: "test/fast",
};
class FakeWorker implements TaskWorker {
	inputs: WorkerInput[] = [];
	stopped = false;
	aborts = 0;
	constructor(
		readonly options: WorkerOptions,
		readonly events: WorkerEvents,
	) {}
	async start(input: WorkerInput) {
		this.inputs.push(input);
	}
	async update(input: WorkerInput) {
		this.inputs.push(input);
	}
	async abort() {
		this.aborts++;
		this.events.onActivity("waiting");
	}
	async stop() {
		this.stopped = true;
	}
	report(revision = this.inputs.at(-1)?.revision ?? 1) {
		const report: TaskReport = {
			taskId: this.options.taskId,
			revision,
			status: "success",
			summary: "Done",
			artifacts: [],
			verification: ["behavior checked"],
			blockers: [],
		};
		this.events.onReport(report);
	}
}
function fixture(
	overrides: {
		maxConcurrency?: number;
		evaluate?: ConstructorParameters<typeof TaskManager>[0]["evaluate"];
		root?: string;
	} = {},
) {
	const root = overrides.root ?? mkdtempSync(path.join(os.tmpdir(), "task-manager-"));
	if (!overrides.root) roots.push(root);
	const workers: FakeWorker[] = [];
	const onTerminal = vi.fn();
	const onLongRunning = vi.fn();
	const evaluate = overrides.evaluate ?? vi.fn(async () => choice);
	const manager = new TaskManager({
		store: new TaskStore(root, "parent-1"),
		cwd: root,
		maxConcurrency: overrides.maxConcurrency ?? 4,
		evaluate,
		createWorker: (options, events) => {
			const worker = new FakeWorker(options, events);
			workers.push(worker);
			return worker;
		},
		onTerminal,
		onLongRunning,
	});
	managers.push(manager);
	return { manager, workers, onTerminal, onLongRunning, evaluate, root };
}
const launched = (workers: FakeWorker[], count: number) =>
	vi.waitFor(() => expect(workers.filter((w) => w.inputs.length)).toHaveLength(count));

describe("Task long-running notices", () => {
	it("notifies once after 30 minutes, including background waits, without stopping work", async () => {
		vi.useFakeTimers();
		const { manager, workers, onLongRunning, onTerminal } = fixture();
		const task = manager.create("Run a long background job", snapshot);
		await vi.advanceTimersByTimeAsync(0);
		workers[0].events.onActivity("waiting");
		await vi.advanceTimersByTimeAsync(LONG_RUNNING_NOTICE_MS - 1);
		expect(onLongRunning).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(onLongRunning).toHaveBeenCalledWith(
			expect.objectContaining({ id: task.id, revision: 1, status: "waiting" }),
			LONG_RUNNING_NOTICE_MS,
		);
		await vi.advanceTimersByTimeAsync(LONG_RUNNING_NOTICE_MS * 2);
		expect(onLongRunning).toHaveBeenCalledTimes(1);
		expect(workers[0].aborts).toBe(0);
		expect(workers[0].stopped).toBe(false);
		expect(onTerminal).not.toHaveBeenCalled();
		workers[0].report();
		await vi.advanceTimersByTimeAsync(0);
		expect(onTerminal).toHaveBeenCalledTimes(1);
	});

	it("starts a fresh notice window when an edit reaches the worker", async () => {
		vi.useFakeTimers();
		const { manager, workers, onLongRunning } = fixture();
		const task = manager.create("Original", snapshot);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(LONG_RUNNING_NOTICE_MS - 1_000);
		await manager.edit(task.id, "New scope");
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onLongRunning).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(LONG_RUNNING_NOTICE_MS - 1_000);
		expect(onLongRunning).toHaveBeenCalledTimes(1);
		expect(onLongRunning.mock.calls[0][0]).toMatchObject({ id: task.id, revision: 2 });
		expect(workers[0].stopped).toBe(false);
	});

	it("does not count concurrency queue time toward the execution notice", async () => {
		vi.useFakeTimers();
		const { manager, workers, onLongRunning } = fixture({ maxConcurrency: 1 });
		const first = manager.create("First", snapshot);
		const second = manager.create("Second", snapshot);
		await vi.advanceTimersByTimeAsync(LONG_RUNNING_NOTICE_MS * 2);
		expect(onLongRunning).toHaveBeenCalledTimes(1);
		expect(onLongRunning.mock.calls[0][0].id).toBe(first.id);
		expect(manager.get(second.id).status).toBe("queued");
		workers[0].report();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(LONG_RUNNING_NOTICE_MS - 1);
		expect(onLongRunning).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(onLongRunning).toHaveBeenCalledTimes(2);
		expect(onLongRunning.mock.calls[1][0].id).toBe(second.id);
	});

	it.each(["report", "failure", "shutdown"])("does not send a late notice after %s", async (ending) => {
		vi.useFakeTimers();
		const { manager, workers, onLongRunning } = fixture();
		manager.create("Work", snapshot);
		await vi.advanceTimersByTimeAsync(0);
		if (ending === "shutdown") await manager.close();
		else if (ending === "failure") workers[0].events.onError("Provider failed");
		else workers[0].report();
		await vi.advanceTimersByTimeAsync(LONG_RUNNING_NOTICE_MS);
		expect(onLongRunning).not.toHaveBeenCalled();
	});
});

describe("Task manager behavior", () => {
	it("returns IDs immediately, queues above the limit, and only final reports free slots", async () => {
		const { manager, workers, onTerminal } = fixture();
		const records = Array.from({ length: 5 }, (_, i) => manager.create(`Task ${i}`, snapshot));
		expect(records.every((r) => r.status === "queued")).toBe(true);
		expect(workers).toHaveLength(0);
		await launched(workers, 4);
		workers[0].events.onActivity("waiting");
		expect(manager.get(records[0].id).status).toBe("waiting");
		expect(manager.get(records[4].id).status).toBe("queued");
		expect(onTerminal).not.toHaveBeenCalled();
		workers[0].report();
		await launched(workers, 5);
		expect(workers[0].stopped).toBe(true);
		expect(manager.get(records[0].id).status).toBe("completed");
		expect(onTerminal).toHaveBeenCalledTimes(1);
		workers[0].report();
		expect(onTerminal).toHaveBeenCalledTimes(1);
	});

	it("edits add instructions and reevaluate without terminating the worker, rejecting old reports", async () => {
		const { manager, workers, evaluate, onTerminal } = fixture();
		const task = manager.create("Fix login", snapshot, true);
		await launched(workers, 1);
		const pending = manager.edit(task.id, "Email only");
		expect(manager.get(task.id).revision).toBe(2);
		workers[0].report(1);
		expect(onTerminal).not.toHaveBeenCalled();
		await pending;
		await vi.waitFor(() => expect(workers[0].inputs).toHaveLength(2));
		expect(workers).toHaveLength(1);
		expect(workers[0].stopped).toBe(false);
		expect(workers[0].inputs[1].prompt).toContain("Fix login");
		expect(workers[0].inputs[1].prompt).toContain("Email only");
		expect(workers[0].options.readonly).toBe(true);
		expect(evaluate).toHaveBeenCalledTimes(2);
		workers[0].report(1);
		expect(manager.get(task.id).status).toBe("running");
		workers[0].report(2);
		await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
		expect(manager.get(task.id).report?.revision).toBe(2);
	});

	it("abort leaves a live worker able to report after a background completion", async () => {
		const { manager, workers, onTerminal } = fixture();
		const task = manager.create("Run tests", snapshot);
		await launched(workers, 1);
		await manager.abort(task.id);
		expect(workers[0].stopped).toBe(false);
		expect(manager.get(task.id).status).toBe("waiting");
		workers[0].events.onActivity("running");
		workers[0].report();
		await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
	});

	it("a cancelled queued launch cannot occupy a concurrency slot forever", async () => {
		const { manager, workers } = fixture({ maxConcurrency: 1 });
		const first = manager.create("Cancelled", snapshot);
		await Promise.resolve();
		await manager.abort(first.id);
		manager.create("Next", snapshot);
		await launched(workers, 1);
		expect(workers[0].inputs[0].prompt).toContain("Next");
	});

	it("late evaluation results cannot launch an outdated revision", async () => {
		let finish: ((value: EvaluationResult) => void) | undefined;
		const evaluate = vi
			.fn<ConstructorParameters<typeof TaskManager>[0]["evaluate"]>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			)
			.mockResolvedValue(choice);
		const { manager, workers } = fixture({ evaluate });
		const task = manager.create("Original", snapshot);
		await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
		const edit = manager.edit(task.id, "Revised");
		finish?.(choice);
		await edit;
		await launched(workers, 1);
		expect(workers[0].inputs[0].revision).toBe(2);
		expect(workers[0].inputs[0].prompt).toContain("Revised");
	});

	it("routing failures report to the parent and allow the next queued Task to run", async () => {
		const evaluate = vi.fn().mockRejectedValueOnce(new Error("No evaluator available")).mockResolvedValue(choice);
		const { manager, workers, onTerminal } = fixture({ maxConcurrency: 1, evaluate });
		const first = manager.create("Will fail", snapshot);
		manager.create("Next", snapshot);
		await launched(workers, 1);
		expect(manager.get(first.id).status).toBe("failed");
		expect(onTerminal).toHaveBeenCalledTimes(1);
		expect(workers[0].inputs[0].prompt).toContain("Next");
	});

	it("recovery shows interruptions once and resumes only when explicitly requested", async () => {
		const first = fixture();
		const task = first.manager.create("Persistent work", snapshot, true);
		await launched(first.workers, 1);
		await first.manager.close();
		const restored = fixture({ root: first.root });
		expect(restored.manager.get(task.id).status).toBe("interrupted");
		expect(restored.manager.takeInterruptions()).toHaveLength(1);
		expect(restored.manager.takeInterruptions()).toHaveLength(0);
		expect(restored.workers).toHaveLength(0);
		await restored.manager.edit(task.id, "Continue");
		await launched(restored.workers, 1);
		expect(restored.workers[0].options.sessionFile).toBe(task.sessionFile);
		expect(restored.workers[0].inputs[0].revision).toBe(2);
	});

	it("shutdown prevents late evaluation from starting a child", async () => {
		let finish: ((value: EvaluationResult) => void) | undefined;
		const evaluate = vi.fn(
			() =>
				new Promise<EvaluationResult>((resolve) => {
					finish = resolve;
				}),
		);
		const { manager, workers } = fixture({ evaluate });
		const task = manager.create("Slow evaluation", snapshot);
		await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
		await manager.close();
		finish?.(choice);
		await Promise.resolve();
		await Promise.resolve();
		expect(workers).toHaveLength(0);
		expect(manager.get(task.id).status).toBe("interrupted");
	});

	it("unexpected worker exit is failure, never a successful final report", async () => {
		const { manager, workers, onTerminal } = fixture();
		const task = manager.create("Work", snapshot);
		await launched(workers, 1);
		workers[0].events.onExit("Worker crashed");
		await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledTimes(1));
		expect(manager.get(task.id).report?.status).toBe("failed");
		expect(manager.get(task.id).report?.summary).toBe("Worker crashed");
	});
});
