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
	it.each([true, undefined])("restores a dropped steer without waking (triggerTurn=%s)", (triggerTurn) => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		setIdle(false);
		guarded.sendMessage(completion, { triggerTurn, deliverAs: "steer" });
		// Escape clears Pi's queue, so no message_end arrives for it.
		setIdle(true);
		emit("agent_settled");

		expect(sendMessage).toHaveBeenCalledTimes(2);
		const [queued, queuedOptions] = sendMessage.mock.calls[0] ?? [];
		expect(queuedOptions).toEqual({ triggerTurn, deliverAs: "steer" });
		expect(queued.details).toMatchObject({ jobIds: ["a"] });
		expect(sendMessage.mock.calls[1]).toEqual([queued, { triggerTurn: false }]);

		emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it("leaves a queued message alone once the model received it", () => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		setIdle(false);
		guarded.sendMessage(completion, { triggerTurn: true, deliverAs: "steer" });
		emit("message_end", { message: sendMessage.mock.calls[0]?.[0] });
		setIdle(true);
		emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("passes idle sends and non-waking messages through untouched", () => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		guarded.sendMessage(completion, { triggerTurn: true, deliverAs: "steer" });
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

	it("restores only undelivered results when several steers arrive before Escape", () => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		setIdle(false);
		for (const id of ["a", "b", "c"]) {
			guarded.sendMessage({ ...completion, content: id }, { triggerTurn: true, deliverAs: "steer" });
		}
		const [first, second, third] = sendMessage.mock.calls.map(([message]) => message);
		emit("message_end", { message: first });
		setIdle(true);
		emit("agent_settled");
		expect(sendMessage.mock.calls.slice(3)).toEqual([
			[second, { triggerTurn: false }],
			[third, { triggerTurn: false }],
		]);
		emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(5);
	});

	it("leaves a message alone when compaction, not an agent run, holds the session", () => {
		const { guarded, sendMessage, emit, setIdle } = setup();
		emit("agent_start");
		setIdle(false);
		emit("agent_settled");
		// The run is over but compaction keeps isIdle() false, so Pi appends the message to the session at
		// once and never reports message_end to extensions.
		guarded.sendMessage(completion, { deliverAs: "steer" });
		expect(sendMessage.mock.calls).toEqual([[completion, { deliverAs: "steer" }]]);

		emit("agent_start");
		setIdle(false);
		setIdle(true);
		emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("drops only its own restored copy when another guard shares the session", () => {
		const mine = setup();
		const other = setup();
		for (const guard of [mine, other]) {
			guard.emit("agent_start");
			guard.setIdle(false);
			guard.guarded.sendMessage(completion, { triggerTurn: true, deliverAs: "steer" });
			guard.setIdle(true);
			guard.emit("agent_settled");
		}
		const asCustom = (message: Record<string, unknown>, timestamp: number) => ({
			role: "custom",
			...message,
			timestamp,
		});
		const mineOriginal = asCustom(mine.sendMessage.mock.calls[0]?.[0], 2);
		const mineRestored = asCustom(mine.sendMessage.mock.calls[1]?.[0], 0);
		const otherOriginal = asCustom(other.sendMessage.mock.calls[0]?.[0], 3);
		const otherRestored = asCustom(other.sendMessage.mock.calls[1]?.[0], 1);

		const messages = [mineRestored, otherRestored, mineOriginal, otherOriginal];
		const result = mine.emit("context", { messages }) as { messages: unknown[] };
		// Both guards start their counters at 1, so only a globally unique id keeps the sibling's pair intact.
		expect(result.messages).toEqual([mineRestored, otherRestored, otherOriginal]);
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
