/** biome-ignore-all lint/suspicious/noExplicitAny: fake external Pi context and child process boundary. */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentAsyncTasks } from "./async-task-lifecycle.js";
import { handleSessionStart, registerAll } from "./commands.js";
import { STALE_PENDING_COMPLETION_MS } from "./constants.js";
import { createStore } from "./store.js";
import { createSubagentToolExecute } from "./tool-execute.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn,
}));

class Host {
	frames: any[] = [];
	listeners = new Set<(frame: any) => void>();
	automatic = true;
	owner: any;
	on(_name: string, callback: (frame: any) => void) {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}
	emit(_name: string, frame: any) {
		validateWire?.(frame);
		this.frames.push(structuredClone(frame));
		for (const callback of this.listeners) callback(frame);
		if (frame.type === "host-query") {
			this.owner = {
				sessionId: "session",
				runtimeInstanceId: "runtime",
				piSessionId: frame.piSessionId,
				providerId: frame.providerId,
				providerInstanceId: frame.providerInstanceId,
			};
			this.reply({
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
		if (frame.type === "task-register" && this.automatic) this.approve(frame);
		if (frame.type === "registration-abandon")
			this.reply({
				type: "task-register-result",
				requestId: frame.requestId,
				taskId: frame.taskId,
				registration: "abandoned",
				outcome: "settled",
			});
	}
	reply(fields: any) {
		this.emit("pi.async-tasks.v1", {
			contract: "pi.async-tasks.v1",
			...this.owner,
			requestId: "control",
			providerRevision: 0,
			controlGeneration: 0,
			...fields,
		});
	}
	approve(frame: any) {
		this.reply({
			type: "task-register-result",
			requestId: frame.requestId,
			taskId: frame.task.taskId,
			registration: "approved",
			outcome: "accepted",
			grantId: `grant-${frame.task.taskId}`,
		});
	}
	get detail() {
		return this.frames.filter((frame) => frame.type === "task-update").at(-1)?.detail;
	}
}
function child() {
	const process = new EventEmitter() as any;
	process.stdout = new EventEmitter();
	process.stderr = new EventEmitter();
	process.exitCode = null;
	process.kill = vi.fn(() => {
		queueMicrotask(() => {
			process.exitCode = 1;
			process.emit("exit", 1);
			process.emit("close", 1);
		});
		return true;
	});
	process.result = () =>
		process.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "DONE" }], stopReason: "stop" } })}\n`,
			),
		);
	process.finish = () => {
		process.result();
		process.exitCode = 0;
		process.emit("exit", 0);
		process.emit("close", 0);
	};
	return process;
}
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
let lifecycle: SubagentAsyncTasks;
beforeEach(() => {
	vi.useFakeTimers();
	spawn.mockReset();
	directory = mkdtempSync(join(tmpdir(), "subagent-hosted-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
	mkdirSync(join(directory, ".pi", "agents"), { recursive: true });
	writeFileSync(
		join(directory, ".pi", "agents", "worker.md"),
		"---\nname: worker\ndescription: offline fixture\nruntime: pi\n---\nOnly use the offline fixture.",
	);
});
afterEach(async () => {
	lifecycle?.shutdown();
	await vi.runOnlyPendingTimersAsync();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});
function setup() {
	const host = new Host();
	const pi = {
		events: host,
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn(),
	};
	lifecycle = new SubagentAsyncTasks(pi as any);
	lifecycle.bind("pi-session");
	const store = createStore();
	store.asyncTasks = lifecycle;
	const context = {
		cwd: directory,
		hasUI: false,
		ui: {
			notify: vi.fn(),
			setWidget: vi.fn(),
			setStatus: vi.fn(),
			onTerminalInput: vi.fn(() => () => {}),
			addAutocompleteProvider: vi.fn(),
		},
		sessionManager: { getSessionFile: () => join(directory, "parent.jsonl"), getEntries: () => [] },
	};
	const execute = createSubagentToolExecute(pi as any, store);
	return { host, pi, store, context, execute };
}

describe("hosted subagent production execution", () => {
	it("does not admit a run or spawn before the root and child durable grants", async () => {
		const { host, store, execute, context, pi } = setup();
		host.automatic = false;
		const proc = child();
		spawn.mockReturnValue(proc);
		const launch = execute("call", { command: "subagent run worker -- finite task" }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(0);
		expect(store.commandRuns.size).toBe(0);
		expect(spawn).not.toHaveBeenCalled();
		host.approve(host.frames.find((frame) => frame.type === "task-register"));
		const result = await launch;
		expect(result.content[0].text).toContain("Started async");
		expect(pi.sendMessage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1001);
		const registrations = host.frames.filter((frame) => frame.type === "task-register");
		expect(registrations).toHaveLength(2);
		expect(spawn).not.toHaveBeenCalled();
		host.approve(registrations[1]);
		await vi.advanceTimersByTimeAsync(0);
		expect(spawn).toHaveBeenCalledOnce();
		proc.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(host.detail.tasks.filter((task: any) => task.taskId === task.rootTaskId)).toMatchObject([
			{ execution: "succeeded", presence: "settled", invocationId: "call" },
		]);
		expect(host.detail.tickets).toMatchObject([{ state: "submitted" }]);
		expect(pi.sendMessage.mock.calls[0][0].details.asyncTasks.completionIds).toHaveLength(1);
	});

	it("keeps the resource active after terminal-message fallback and records its later exit", async () => {
		const { host, execute, context } = setup();
		const proc = child();
		proc.kill = vi.fn(() => true);
		spawn.mockReturnValue(proc);
		await execute("call", { command: "subagent run worker -- finite task" }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(1001);
		proc.result();
		await vi.advanceTimersByTimeAsync(10_000);
		const root = () => host.detail.tasks.find((task: any) => task.taskId === task.rootTaskId);
		expect(root()).toMatchObject({ execution: "succeeded", presence: "active" });
		expect(host.detail.tickets).toMatchObject([{ state: "submitted" }]);
		proc.exitCode = 0;
		proc.emit("exit", 0);
		proc.emit("close", 0);
		expect(root()).toMatchObject({ execution: "succeeded", presence: "settled" });
	});

	it("keeps a chain root through the step gap and cancels the queued next step", async () => {
		const { host, execute, context, pi } = setup();
		const first = child();
		spawn.mockReturnValue(first);
		await execute(
			"chain",
			{ command: 'subagent chain --agent worker --task "one" --agent worker --task "two"' },
			undefined,
			undefined,
			context,
		);
		await vi.advanceTimersByTimeAsync(1001);
		first.finish();
		await vi.advanceTimersByTimeAsync(0);
		const root = host.detail.tasks.find((task: any) => task.taskId === task.rootTaskId);
		expect(root.execution).toBe("running");
		expect(root.presence).toBe("active");
		host.reply({ type: "control-request", action: "cancel", taskId: root.taskId, deliveryIds: [] });
		await vi.advanceTimersByTimeAsync(1001);
		expect(spawn).toHaveBeenCalledOnce();
		expect(host.detail.tasks.find((task: any) => task.taskId === root.taskId).execution).toBe("cancelled");
		expect(pi.sendMessage.mock.calls.at(-1)?.[0].details.asyncTasks.taskIds).toEqual([root.taskId]);
	});

	it("makes continue a new attempt even when the visible run ID is reused", async () => {
		const { host, execute, context, store } = setup();
		const first = child();
		spawn.mockReturnValue(first);
		await execute("first", { command: "subagent run worker -- one" }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(1001);
		first.finish();
		await vi.advanceTimersByTimeAsync(0);
		const runId = [...store.commandRuns.keys()][0];
		const second = child();
		spawn.mockReturnValue(second);
		await execute("second", { command: `subagent continue ${runId} -- two` }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(1001);
		second.finish();
		await vi.advanceTimersByTimeAsync(0);
		const roots = host.detail.tasks.filter((task: any) => task.taskId === task.rootTaskId);
		expect(roots).toHaveLength(2);
		expect(new Set(roots.map((task: any) => task.taskId)).size).toBe(2);
		expect(store.commandRuns.size).toBe(1);
	});
	it("tracks slash starts and preserves hidden headless rejection", async () => {
		const { host, pi, store, context } = setup();
		const commands = registerAll(pi as any, store).commands;
		const handler = commands.get("sub:isolate")?.handler;
		if (!handler) throw new Error("slash command missing");
		const proc = child();
		spawn.mockReturnValue(proc);
		await handler("worker finite slash task", context as any);
		await vi.advanceTimersByTimeAsync(1001);
		proc.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(host.detail.tickets).toMatchObject([{ state: "submitted" }]);
		expect(pi.sendMessage.mock.calls.some(([message]) => Boolean(message.details?.asyncTasks))).toBe(true);
		const registrationsBefore = host.frames.filter((frame) => frame.type === "task-register").length;
		for (const [event, callback] of pi.on.mock.calls as any[]) {
			if (event === "input") await callback({ source: "interactive", text: "> worker hidden task" }, context);
		}
		expect(host.frames.filter((frame) => frame.type === "task-register")).toHaveLength(registrationsBefore);
		expect(spawn).toHaveBeenCalledOnce();
		expect(pi.sendMessage.mock.calls.at(-1)?.[0].content).toContain("requires interactive UI");
	});

	it("does not expose hidden output to model messages or activity", async () => {
		const { host, pi, store, context } = setup();
		registerAll(pi as any, store);
		const proc = child();
		spawn.mockReturnValue(proc);
		for (const [event, callback] of pi.on.mock.calls as any[]) {
			if (event === "input")
				await callback({ source: "interactive", text: "> worker hidden task" }, { ...context, hasUI: true });
		}
		await vi.advanceTimersByTimeAsync(1001);
		proc.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(host.detail.tasks.find((task: any) => task.taskId === task.rootTaskId)).toMatchObject({
			execution: "succeeded",
			presence: "settled",
		});
		expect(host.detail.tickets).toEqual([]);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(host.frames.some((frame) => frame.type === "subagent-activity")).toBe(false);
	});

	it("keeps origin-session completion pending and correlates it when the session returns", async () => {
		const { host, pi, store, context, execute } = setup();
		const origin = context.sessionManager.getSessionFile();
		let active = origin;
		context.sessionManager.getSessionFile = () => active;
		const proc = child();
		spawn.mockReturnValue(proc);
		await execute("origin", { command: "subagent run worker -- origin task" }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(1001);
		active = join(directory, "other.jsonl");
		proc.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(host.detail.tickets).toMatchObject([{ state: "pending" }]);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		active = origin;
		handleSessionStart(lifecycle.wrap(pi as any), store, context as any);
		expect(host.detail.tickets).toMatchObject([{ state: "submitted" }]);
		expect(pi.sendMessage.mock.calls.at(-1)?.[0].details.asyncTasks.completionIds).toHaveLength(1);
	});

	it("retains a shutdown root until the actual child exits", async () => {
		const { host, execute, context } = setup();
		const proc = child();
		proc.kill = vi.fn(() => true);
		spawn.mockReturnValue(proc);
		await execute("shutdown", { command: "subagent run worker -- finite task" }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(1001);
		lifecycle.shutdown();
		const root = () => host.detail.tasks.find((task: any) => task.taskId === task.rootTaskId);
		expect(root()).toMatchObject({ execution: "interrupted", presence: "active" });
		proc.exitCode = 1;
		proc.emit("exit", 1);
		proc.emit("close", 1);
		await vi.advanceTimersByTimeAsync(0);
		expect(root()).toMatchObject({ execution: "interrupted", presence: "settled" });
		expect(host.detail.tickets).toMatchObject([{ state: "suppressed" }]);
	});
	it("keeps one batch root alive after partial failure and submits one final ticket", async () => {
		const { host, execute, context, pi } = setup();
		const first = child();
		const second = child();
		spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
		await execute(
			"batch",
			{ command: 'subagent batch --agent worker --task "one" --agent worker --task "two"' },
			undefined,
			undefined,
			context,
		);
		await vi.advanceTimersByTimeAsync(1001);
		first.stdout.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "invalid request" }], stopReason: "error", errorMessage: "invalid request" } })}\n`,
			),
		);
		first.exitCode = 1;
		first.emit("exit", 1);
		first.emit("close", 1);
		await vi.advanceTimersByTimeAsync(0);
		const root = () => host.detail.tasks.find((task: any) => task.taskId === task.rootTaskId);
		expect(root()).toMatchObject({ execution: "running", presence: "active" });
		expect(host.detail.tickets).toEqual([]);
		await vi.advanceTimersByTimeAsync(1001);
		second.finish();
		await vi.advanceTimersByTimeAsync(0);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(root()).toMatchObject({ execution: "failed", presence: "settled" });
		expect(host.detail.tickets).toMatchObject([{ state: "submitted" }]);
		expect(pi.sendMessage.mock.calls.filter(([message]) => message.details?.asyncTasks)).toHaveLength(1);
	});

	it("retains expired pending output and reports failed delivery rather than losing the obligation", async () => {
		const { host, execute, context, pi, store } = setup();
		let active = context.sessionManager.getSessionFile();
		context.sessionManager.getSessionFile = () => active;
		const proc = child();
		spawn.mockReturnValue(proc);
		await execute("expired", { command: "subagent run worker -- origin task" }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(1001);
		active = join(directory, "other.jsonl");
		proc.finish();
		await vi.advanceTimersByTimeAsync(0);
		vi.setSystemTime(Date.now() + STALE_PENDING_COMPLETION_MS + 1);
		handleSessionStart(lifecycle.wrap(pi as any), store, context as any);
		expect(host.detail.tickets).toMatchObject([{ state: "failed", failureReason: expect.stringContaining("expired") }]);
		const root = host.detail.tasks.find((task: any) => task.taskId === task.rootTaskId);
		host.reply({ type: "control-request", action: "detail", taskId: root.taskId, deliveryIds: [] });
		await vi.advanceTimersByTimeAsync(0);
		expect(host.frames.at(-1)).toMatchObject({
			type: "control-result",
			outcome: "settled",
			detail: expect.stringContaining("DONE"),
		});
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
	it("settles explicit removal without suppressing other roots or sending the removed result", async () => {
		const { host, execute, context, pi } = setup();
		const proc = child();
		spawn.mockReturnValue(proc);
		await execute("removed", { command: "subagent run worker -- remove this" }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(1001);
		await execute("remove", { command: "subagent remove 1" }, undefined, undefined, context);
		await vi.advanceTimersByTimeAsync(0);
		expect(host.detail.tasks.find((task: any) => task.taskId === task.rootTaskId)).toMatchObject({
			execution: "cancelled",
			presence: "settled",
		});
		expect(host.detail.tickets).toMatchObject([{ state: "suppressed" }]);
		expect(pi.sendMessage.mock.calls.some(([message]) => message.details?.asyncTasks)).toBe(false);
		expect(lifecycle.provider.accepting).toBe(true);
	});
});
