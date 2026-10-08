import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.js";
import extension from "./index.js";
import { LONG_RUNNING_NOTICE_MS } from "./manager.js";
import type { TaskRecord, WorkerEvents, WorkerInput, WorkerOptions } from "./types.js";

const state = vi.hoisted(() => ({
	root: "",
	workers: [] as Array<{
		options: WorkerOptions;
		events: WorkerEvents;
		inputs: WorkerInput[];
		stopped: boolean;
	}>,
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => state.root }));
vi.mock("./routing/config.js", () => ({ loadTaskConfig: () => ({ maxConcurrency: 4 }) }));
vi.mock("./routing/evaluate.js", () => ({
	evaluateTask: async () => ({
		tier: "fast",
		selection: { provider: "test", model: "fast", thinking: "low" },
		evaluator: "test/fast",
	}),
}));
vi.mock("./runtime/rpc-worker.js", () => ({
	createRpcWorker: (options: WorkerOptions, events: WorkerEvents) => {
		const worker = { options, events, inputs: [] as WorkerInput[], stopped: false };
		state.workers.push(worker);
		return {
			start: async (input: WorkerInput) => {
				worker.inputs.push(input);
			},
			update: async (input: WorkerInput) => {
				worker.inputs.push(input);
			},
			abort: async () => {},
			stop: async () => {
				worker.stopped = true;
			},
		};
	},
}));

let api: ReturnType<typeof createExtensionApiMock>;
let ctx: ExtensionContext;
beforeEach(() => {
	state.root = mkdtempSync(path.join(os.tmpdir(), "task-extension-"));
	state.workers = [];
	api = createExtensionApiMock();
	ctx = {
		cwd: state.root,
		hasUI: true,
		model: { provider: "test", id: "main" },
		ui: { notify: vi.fn() },
		sessionManager: { getSessionId: () => "parent", getBranch: () => [] },
	} as unknown as ExtensionContext;
});
afterEach(async () => {
	for (const handler of api.getHandlers("session_shutdown")) await handler({}, ctx);
	vi.unstubAllEnvs();
	vi.useRealTimers();
	rmSync(state.root, { recursive: true, force: true });
});
async function call(params: Record<string, unknown>) {
	return (await api.getTool("Task").execute?.("call", params, undefined, undefined, ctx)) as {
		details: { task: TaskRecord };
		isError?: boolean;
	};
}
async function create() {
	extension(api.api);
	const response = await call({ task: "Investigate", readonly: true });
	expect(response.isError).not.toBe(true);
	await vi.waitFor(() => expect(state.workers[0]?.inputs).toHaveLength(1));
	return response.details.task;
}

describe("Task extension interface", () => {
	it("exposes Task control through the tool without user-facing slash commands", () => {
		extension(api.api);
		expect(api.tools.has("Task")).toBe(true);
		expect(api.commands.size).toBe(0);
	});

	it("gives Task IDs immediately and delivers only explicit reports", async () => {
		const task = await create();
		state.workers[0].events.onActivity("waiting");
		expect(api.sentMessages).toHaveLength(0);
		state.workers[0].events.onReport({
			taskId: task.id,
			revision: 1,
			status: "success",
			summary: "Verified",
			artifacts: [],
			verification: ["tests"],
			blockers: [],
		});
		await vi.waitFor(() => expect(api.sentMessages).toHaveLength(1));
		expect(api.sentMessages[0]).toMatchObject({
			customType: "task-completion",
			details: { taskId: task.id, revision: 1 },
		});
		expect(state.workers[0].stopped).toBe(true);
	});

	it("sends a nonterminal progress notice and drops it if completion overtakes delivery", async () => {
		vi.useFakeTimers();
		extension(api.api);
		const response = await call({ task: "Long work" });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(LONG_RUNNING_NOTICE_MS);
		expect(api.sentMessages).toHaveLength(1);
		expect(api.sentMessages[0]).toMatchObject({
			customType: "task-long-running",
			details: { taskId: response.details.task.id, revision: 1, elapsedMs: LONG_RUNNING_NOTICE_MS },
		});
		expect(state.workers[0].stopped).toBe(false);
		const notice = { role: "custom", ...(api.sentMessages[0] as Record<string, unknown>) };
		const context = api.getHandlers("context")[0];
		expect(await context({ messages: [notice] }, ctx)).toEqual({ messages: [notice] });
		state.workers[0].events.onReport({
			taskId: response.details.task.id,
			revision: 1,
			status: "success",
			summary: "Done after the notice",
			artifacts: [],
			verification: [],
			blockers: [],
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(api.sentMessages).toHaveLength(2);
		expect(api.sentMessages[1]).toMatchObject({ customType: "task-completion" });
		expect(await context({ messages: [notice] }, ctx)).toEqual({ messages: [] });
	});

	it("filters a queued old report out of parent context after an edit", async () => {
		const task = await create();
		await call({ action: "edit", taskId: task.id, task: "New scope" });
		const handler = api.getHandlers("context")[0];
		const old = {
			role: "custom",
			customType: "task-completion",
			details: { taskId: task.id, revision: 1 },
			content: "old",
		};
		const user = { role: "user", content: "hello" };
		const progress = { ...old, customType: "task-long-running" };
		const filtered = await handler({ messages: [old, progress, user] }, ctx);
		expect(filtered).toEqual({ messages: [user] });
	});

	it("does not expose recursive parent controls inside a Task worker", () => {
		vi.stubEnv("PI_TASK_WORKER", "1");
		extension(api.api);
		expect(api.tools.size).toBe(0);
		expect(api.commands.size).toBe(0);
	});

	it("shows one recovery notice without starting any recovered worker", async () => {
		await create();
		for (const handler of api.getHandlers("session_shutdown")) await handler({}, ctx);
		state.workers = [];
		api = createExtensionApiMock();
		extension(api.api);
		for (const handler of api.getHandlers("session_start")) await handler({}, ctx);
		expect(api.sentMessages).toHaveLength(1);
		expect(api.sentMessages[0]).toMatchObject({ customType: "task-recovery" });
		expect(state.workers).toHaveLength(0);
		for (const handler of api.getHandlers("session_start")) await handler({}, ctx);
		expect(api.sentMessages).toHaveLength(1);
	});
});
