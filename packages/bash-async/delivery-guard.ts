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
 * busy would vanish. This tracks every turn-triggering message queued during a run, and when the run
 * settles without the message reaching the model, appends it to the session without starting a turn:
 * the user sees it now, and the model sees it on the next prompt.
 *
 * Extensions cannot tell Escape from other aborts: Pi's pending count covers only typed messages, not
 * extension messages. An abort while the model streams keeps the original queued, and Pi delivers it on
 * the next run after the restored copy. Both carry the same guard id, so the model input keeps only the first.
 */
export function guardQueuedDeliveries(pi: ExtensionAPI): ExtensionAPI {
	let context: ExtensionContext | undefined;
	let nextId = 0;
	const queued = new Map<string, Message>();

	const busy = () => {
		try {
			return context ? !context.isIdle() : false;
		} catch {
			return false;
		}
	};

	const restored = new Set<string>();

	pi.on("agent_start", (_event, ctx) => {
		context = ctx;
	});
	pi.on("message_end", (event) => {
		const id = guardId(event.message);
		if (id) queued.delete(id);
	});
	pi.on("agent_settled", (_event, ctx) => {
		context = ctx;
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
		context = undefined;
	});

	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property !== "sendMessage") return Reflect.get(target, property, receiver);
			const send: SendMessage = (message, options) => {
				// An idle send starts its own run with the message as the prompt, so nothing can drop it.
				if (options?.triggerTurn !== true || options.deliverAs === "nextTurn" || !busy()) {
					target.sendMessage(message, options);
					return;
				}
				const id = String(++nextId);
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
