import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { guardQueuedDeliveries } from "./delivery-guard.js";

function setup() {
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	const sendMessage = vi.fn();
	let idle = true;
	let pending = false;
	const pi = {
		on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => handlers.set(event, handler),
		sendMessage,
	};
	const guarded = guardQueuedDeliveries(pi as unknown as ExtensionAPI);
	const ctx = { isIdle: () => idle, hasPendingMessages: () => pending };
	const emit = (type: string, event: Record<string, unknown> = {}) => handlers.get(type)?.({ type, ...event }, ctx);
	return {
		guarded,
		sendMessage,
		emit,
		setIdle: (value: boolean) => {
			idle = value;
		},
		setPending: (value: boolean) => {
			pending = value;
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

	it("waits for Pi to deliver a message an abort left in the queue", () => {
		const { guarded, sendMessage, emit, setIdle, setPending } = setup();
		emit("agent_start");
		setIdle(false);
		guarded.sendMessage(completion, { triggerTurn: true, deliverAs: "followUp" });
		// A non-Escape abort keeps Pi's queue, so re-appending now would deliver the message twice.
		setIdle(true);
		setPending(true);
		emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(1);

		emit("message_end", { message: sendMessage.mock.calls[0]?.[0] });
		setPending(false);
		emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(1);
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
