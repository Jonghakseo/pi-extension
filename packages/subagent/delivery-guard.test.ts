import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { guardQueuedDeliveries } from "./delivery-guard.js";

function setup() {
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	const sendMessage = vi.fn();
	let idle = true;
	const pi = {
		on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => handlers.set(event, handler),
		sendMessage,
	};
	const guarded = guardQueuedDeliveries(pi as unknown as ExtensionAPI);
	const ctx = { isIdle: () => idle };
	const emit = (type: string, event: Record<string, unknown> = {}) => handlers.get(type)?.({ type, ...event }, ctx);
	return {
		guarded,
		sendMessage,
		emit,
		setIdle: (value: boolean) => {
			idle = value;
		},
	};
}

const completion = { customType: "done", content: "job failed", display: true, details: { jobIds: ["a"] } };

describe("guardQueuedDeliveries", () => {
	it("appends a message the queue dropped once the run settles, without starting a turn", () => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		setIdle(false);
		guarded.sendMessage(completion, { triggerTurn: true, deliverAs: "steer" });
		// Escape clears Pi's queue, so no message_end arrives for it.
		setIdle(true);
		emit("agent_settled");

		expect(sendMessage).toHaveBeenCalledTimes(2);
		const [queued, queuedOptions] = sendMessage.mock.calls[0] ?? [];
		expect(queuedOptions).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(queued.details).toMatchObject({ jobIds: ["a"] });
		expect(sendMessage.mock.calls[1]).toEqual([queued, { triggerTurn: false }]);

		emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it("leaves a queued message alone once the model received it", () => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		setIdle(false);
		guarded.sendMessage(completion, { triggerTurn: true, deliverAs: "followUp" });
		emit("message_end", { message: sendMessage.mock.calls[0]?.[0] });
		setIdle(true);
		emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("passes idle sends and non-waking messages through untouched", () => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		guarded.sendMessage(completion, { triggerTurn: true, deliverAs: "followUp" });
		setIdle(false);
		guarded.sendMessage(completion, { triggerTurn: false });
		guarded.sendMessage(completion, { deliverAs: "nextTurn" });
		setIdle(true);
		emit("agent_settled");

		expect(sendMessage).toHaveBeenCalledTimes(3);
		for (const [message] of sendMessage.mock.calls) expect(message).toBe(completion);
	});

	it("keeps only the restored copy when an abort left the original queued", () => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		setIdle(false);
		guarded.sendMessage(completion, { triggerTurn: true, deliverAs: "steer" });
		setIdle(true);
		emit("agent_settled");
		const restored = sendMessage.mock.calls[1]?.[0];

		// Pi still held the original and delivers it on the next run, after the restored copy.
		const user = { role: "user", content: "next", timestamp: 1 };
		const original = { role: "custom", ...sendMessage.mock.calls[0]?.[0], timestamp: 2 };
		const copy = { role: "custom", ...restored, timestamp: 0 };
		const result = emit("context", { messages: [copy, user, original] }) as { messages: unknown[] };
		expect(result.messages).toEqual([copy, user]);
		expect(emit("context", { messages: [user] })).toBeUndefined();
	});

	it("forgets queued messages on session shutdown", () => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		setIdle(false);
		guarded.sendMessage(completion, { triggerTurn: true, deliverAs: "steer" });
		emit("session_shutdown");
		emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});
});
