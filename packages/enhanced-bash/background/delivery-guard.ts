import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type SendMessage = ExtensionAPI["sendMessage"];
type Message = Parameters<SendMessage>[0];

const GUARD_ID_KEY = "deliveryGuardId";

function guardId(message: unknown): string | undefined {
	const details = (message as { details?: unknown } | undefined)?.details;
	if (!details || typeof details !== "object") return undefined;
	const id = (details as Record<string, unknown>)[GUARD_ID_KEY];
	return typeof id === "string" ? id : undefined;
}

/**
 * Pi keeps steer and follow-up messages in an in-memory queue until the agent loop picks them up, and
 * Escape clears that queue without restoring custom messages. A completion queued while the agent was
 * busy would vanish. This tracks every message queued during a run, and when the run
 * settles without the message reaching the model, appends it to the session without starting a turn:
 * the user sees it now, and the model sees it on the next prompt.
 *
 * Extensions cannot tell Escape from other aborts: Pi's pending count covers only typed messages, not
 * extension messages. An abort while the model streams keeps the original queued, and Pi delivers it on
 * the next run after the restored copy. Both carry the same guard id, so the model input keeps only the first.
 */
export function guardQueuedDeliveries(pi: ExtensionAPI): ExtensionAPI {
	let context: ExtensionContext | undefined;
	// Several extensions ship this guard, and the context event hands each of them every extension's
	// messages. A per-instance prefix keeps ids unique across extensions and across session restarts, so a
	// guard never drops a sibling's message that happens to carry the same counter value.
	const instance = randomUUID();
	let nextId = 0;
	let runActive = false;
	const queued = new Map<string, Message>();

	// Only a message Pi queues for a running agent loop can be dropped. When compaction alone holds the
	// session, isIdle() is false with no agent run, and Pi appends the message to the session right away
	// without reporting message_end to extensions, so tracking it would restore a duplicate at the next settle.
	const atRisk = () => {
		if (!runActive) return false;
		try {
			return context ? !context.isIdle() : false;
		} catch {
			return false;
		}
	};

	const restored = new Set<string>();

	pi.on("agent_start", (_event, ctx) => {
		context = ctx;
		runActive = true;
	});
	pi.on("message_end", (event) => {
		const id = guardId(event.message);
		if (id) queued.delete(id);
	});
	pi.on("agent_settled", (_event, ctx) => {
		context = ctx;
		runActive = false;
		if (queued.size === 0) return;
		const lost = [...queued.entries()];
		queued.clear();
		for (const [id, message] of lost) {
			restored.add(id);
			pi.sendMessage(message, { triggerTurn: false });
		}
	});
	pi.on("context", (event) => {
		if (restored.size === 0) return;
		const seen = new Set<string>();
		let dropped = false;
		const messages = event.messages.filter((message) => {
			const id = guardId(message);
			if (!id || !restored.has(id)) return true;
			if (!seen.has(id)) {
				seen.add(id);
				return true;
			}
			dropped = true;
			return false;
		});
		return dropped ? { messages } : undefined;
	});
	pi.on("session_shutdown", () => {
		queued.clear();
		restored.clear();
		runActive = false;
		context = undefined;
	});

	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property !== "sendMessage") return Reflect.get(target, property, receiver);
			const send: SendMessage = (message, options) => {
				// An idle send starts its own run with the message as the prompt, so nothing can drop it.
				if (options?.triggerTurn === false || options?.deliverAs === "nextTurn" || !atRisk()) {
					target.sendMessage(message, options);
					return;
				}
				const id = `${instance}:${++nextId}`;
				const details = message.details && typeof message.details === "object" ? message.details : {};
				const tagged = { ...message, details: { ...details, [GUARD_ID_KEY]: id } } as Message;
				queued.set(id, tagged);
				try {
					target.sendMessage(tagged, options);
				} catch (error) {
					queued.delete(id);
					throw error;
				}
			};
			return send;
		},
	});
}
