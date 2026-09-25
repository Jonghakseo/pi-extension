import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AsyncTaskProvider, type ProviderBus } from "./async-task-provider.js";

type Frame = Record<string, unknown>;
class Bus implements ProviderBus {
	listeners = new Set<(message: unknown) => void>();
	frames: Frame[] = [];
	on(_channel: string, listener: (message: unknown) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	emit(_channel: string, message: unknown) {
		const frame = structuredClone(message) as Frame;
		this.frames.push(frame);
		validate?.(frame);
		for (const listener of this.listeners) listener(frame);
	}
}
let validate: ((frame: unknown) => unknown) | undefined;
beforeAll(async () => {
	const root = process.env.PICKY_CONTRACT_ROOT;
	if (!root) {
		if (process.env.PICKY_CONTRACT_REQUIRED === "1") throw new Error("PICKY_CONTRACT_ROOT is required");
		return;
	}
	const module = await import(
		/* @vite-ignore */ pathToFileURL(join(root, "agentd/src/domain/async-task-contract.ts")).href
	);
	validate = (frame) => module.AsyncTaskHostMessageSchema.parse(frame);
	const fixtures = join(root, "contracts/extensions/async-tasks-v1");
	for (const file of await readdir(fixtures))
		if (file.endsWith(".json")) validate(JSON.parse(await readFile(join(fixtures, file), "utf8")));
});
afterEach(() => vi.useRealTimers());

function setup() {
	const bus = new Bus();
	const hooks = { cancel: vi.fn(), detail: vi.fn(() => "output"), close: vi.fn() };
	const provider = new AsyncTaskProvider(bus, "bash-async", "0.2.1", hooks, 20);
	provider.bind("pi-session");
	const query = bus.frames[0];
	const owner = {
		sessionId: "session",
		runtimeInstanceId: "runtime",
		piSessionId: query.piSessionId,
		providerId: query.providerId,
		providerInstanceId: query.providerInstanceId,
	};
	const host = (fields: Frame) =>
		bus.emit("pi.async-tasks.v1", {
			contract: "pi.async-tasks.v1",
			...owner,
			providerRevision: 0,
			controlGeneration: 0,
			requestId: "host-request",
			...fields,
		});
	host({
		type: "host-state",
		requestId: query.requestId,
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
	const approve = (frame: Frame) => {
		const task = frame.task as Frame;
		host({
			type: "task-register-result",
			requestId: frame.requestId,
			taskId: task.taskId,
			registration: "approved",
			outcome: "accepted",
			grantId: `grant-${task.taskId}`,
		});
	};
	return { provider, bus, hooks, host, approve };
}
function detail(bus: Bus) {
	return bus.frames.filter((frame) => frame.type === "task-update").at(-1)?.detail as {
		tasks: Frame[];
		tickets: Frame[];
	};
}

describe("provider grant and delivery protocol", () => {
	it("waits for a durable grant, consumes it only once, and publishes terminal plus pending ticket atomically", async () => {
		const { provider, bus, approve } = setup();
		const reservation = provider.reserve({ taskId: "job", title: "test", kind: "bash" });
		expect(provider.start("job")).toBe(false);
		approve(bus.frames.find((frame) => frame.type === "task-register") as Frame);
		expect(await reservation).toBe("job");
		expect(provider.start("job")).toBe(true);
		expect(provider.start("job")).toBe(false);
		provider.finish("job", "succeeded", "settled");
		expect(detail(bus)).toMatchObject({
			tasks: [{ execution: "succeeded", presence: "settled" }],
			tickets: [{ state: "pending" }],
		});
		expect(provider.retained("job")).toBe(true);
		provider.shutdown();
	});

	it("queries a lost grant with the same task identity and never launches after late abandonment", async () => {
		vi.useFakeTimers();
		const { provider, bus, host } = setup();
		const signal = new AbortController();
		const reservation = provider.reserve({ taskId: "job", title: "test", kind: "bash" }, signal.signal);
		const rejected = expect(reservation).rejects.toThrow("not approved");
		await vi.advanceTimersByTimeAsync(20);
		const query = bus.frames.find((frame) => frame.type === "registration-query");
		expect(query?.taskId).toBe("job");
		signal.abort();
		host({
			type: "task-register-result",
			requestId: query?.requestId,
			taskId: "job",
			registration: "approved",
			outcome: "accepted",
			grantId: "lost-grant",
		});
		await vi.advanceTimersByTimeAsync(0);
		const abandon = bus.frames.find((frame) => frame.type === "registration-abandon");
		expect(abandon?.neverSpawned).toBe(true);
		host({
			type: "task-register-result",
			requestId: abandon?.requestId,
			taskId: "job",
			registration: "abandoned",
			outcome: "settled",
		});
		await rejected;
		expect(provider.start("job")).toBe(false);
		expect(detail(bus).tasks[0]).toMatchObject({ registration: "abandoned", presence: "settled" });
		provider.shutdown();
	});

	it("preserves submitted obligations until observation and does not treat send return as handled", async () => {
		const { provider, bus, approve, host } = setup();
		bus.on("pi.async-tasks.v1", (value) => {
			const frame = value as Frame;
			if (frame.type === "task-register") approve(frame);
		});
		await provider.reserve({ taskId: "job", title: "test", kind: "bash" });
		provider.start("job");
		provider.finish("job", "succeeded", "settled");
		const send = vi.fn();
		provider.deliver(["job"], { details: { jobIds: ["job"] } }, send);
		expect(send).toHaveBeenCalledOnce();
		const metadata = send.mock.calls[0][0].details.asyncTasks;
		expect(metadata.taskIds).toEqual(["job"]);
		expect(detail(bus).tickets[0].state).toBe("submitted");
		expect(provider.retained("job")).toBe(true);
		host({ type: "completion-observed", deliveryId: metadata.deliveryId, completionIds: metadata.completionIds });
		expect(provider.retained("job")).toBe(false);
		provider.deliver(["job"], { details: {} }, send);
		expect(send).toHaveBeenCalledOnce();
		provider.shutdown();
	});

	it("fences delivery before close ACK, ignores wrong owners, and accepts late resource exit", async () => {
		const { provider, bus, approve, host, hooks } = setup();
		bus.on("pi.async-tasks.v1", (value) => {
			const frame = value as Frame;
			if (frame.type === "task-register") approve(frame);
		});
		await provider.reserve({ taskId: "job", title: "test", kind: "bash" });
		provider.start("job");
		provider.finish("job", "failed", "unknown");
		host({
			type: "control-request",
			action: "closeAdmission",
			deliveryIds: [],
			controlGeneration: 1,
			runtimeInstanceId: "wrong",
		});
		expect(provider.accepting).toBe(true);
		host({ type: "control-request", action: "closeAdmission", deliveryIds: [], controlGeneration: 1 });
		expect(provider.accepting).toBe(false);
		const send = vi.fn();
		provider.deliver(["job"], { details: {} }, send);
		expect(send).not.toHaveBeenCalled();
		await vi.waitFor(() => {
			expect(bus.frames.find((frame) => frame.type === "control-result")).toMatchObject({
				type: "control-result",
				admissionClosed: true,
				outcome: "settled",
			});
		});
		expect(hooks.close).toHaveBeenCalledOnce();
		provider.resource("job", "settled");
		expect(detail(bus)).toMatchObject({
			tasks: [{ execution: "failed", presence: "settled" }],
			tickets: [{ state: "suppressed" }],
		});
		provider.shutdown();
	});

	it("keeps timeouts unknown and does not turn a late grant into permission", async () => {
		vi.useFakeTimers();
		const { provider, bus, approve } = setup();
		const reservation = provider.reserve({ taskId: "job", title: "test", kind: "bash" });
		const rejected = expect(reservation).rejects.toThrow("not approved");
		await vi.advanceTimersByTimeAsync(61);
		await rejected;
		approve(bus.frames.find((frame) => frame.type === "task-register") as Frame);
		expect(provider.start("job")).toBe(false);
		expect(detail(bus).tasks[0]).toMatchObject({ presence: "unknown", execution: "interrupted" });
		provider.shutdown();
	});
	it("records synchronous delivery failure and keeps its task retained", async () => {
		const { provider, bus, approve } = setup();
		bus.on("pi.async-tasks.v1", (value) => {
			const frame = value as Frame;
			if (frame.type === "task-register") approve(frame);
		});
		await provider.reserve({ taskId: "job", title: "test", kind: "bash" });
		provider.start("job");
		provider.finish("job", "succeeded", "settled");
		provider.deliver(["job"], { details: {} }, () => {
			throw new Error("delivery failed");
		});
		expect(detail(bus).tickets).toMatchObject([
			{ state: "failed", failureReason: expect.stringContaining("delivery failed") },
		]);
		expect(provider.retained("job")).toBe(true);
		provider.shutdown();
	});
	it("does not send if a synchronous host listener closes admission during delivery publication", async () => {
		const { provider, bus, approve, host } = setup();
		bus.on("pi.async-tasks.v1", (value) => {
			const frame = value as Frame;
			if (frame.type === "task-register") approve(frame);
		});
		await provider.reserve({ taskId: "job", title: "test", kind: "bash" });
		provider.start("job");
		provider.finish("job", "succeeded", "settled");
		let closed = false;
		bus.on("pi.async-tasks.v1", (value) => {
			const frame = value as Frame;
			if (!closed && frame.type === "task-update" && detail(bus).tickets[0]?.state === "submitted") {
				closed = true;
				host({ type: "control-request", action: "closeAdmission", deliveryIds: [], controlGeneration: 1 });
			}
		});
		const send = vi.fn();
		provider.deliver(["job"], { details: {} }, send);
		expect(send).not.toHaveBeenCalled();
		expect(detail(bus).tickets[0].state).toBe("suppressed");
		provider.shutdown();
	});
	it("refuses to rebind unresolved work and creates a fresh provider identity after observation", async () => {
		const { provider, bus, approve, host } = setup();
		bus.on("pi.async-tasks.v1", (value) => {
			const frame = value as Frame;
			if (frame.type === "task-register") approve(frame);
		});
		await provider.reserve({ taskId: "job", title: "test", kind: "bash" });
		provider.start("job");
		expect(() => provider.bind("next-pi-session")).toThrow("still owns tasks");
		provider.finish("job", "succeeded", "settled");
		const send = vi.fn();
		provider.deliver(["job"], { details: {} }, send);
		const metadata = send.mock.calls[0][0].details.asyncTasks;
		host({ type: "completion-observed", deliveryId: metadata.deliveryId, completionIds: metadata.completionIds });
		provider.bind("next-pi-session");
		const discoveries = bus.frames.filter((frame) => frame.type === "host-query");
		expect(discoveries).toHaveLength(2);
		expect(discoveries[1].providerInstanceId).not.toBe(discoveries[0].providerInstanceId);
		expect(provider.supported).toBe(false);
		provider.resource("job", "settled");
		expect(bus.frames.at(-1)?.type).toBe("host-query");
		provider.shutdown();
	});
});
