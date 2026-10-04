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

	const stillQueued = (ctx: ExtensionContext) => {
		try {
			return ctx.hasPendingMessages();
		} catch {
			return false;
		}
	};

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
		// Only Escape clears the queue. Any other abort leaves it intact, and Pi delivers it on the next run.
		if (stillQueued(ctx)) return;
		const lost = [...queued.values()];
		queued.clear();
		for (const message of lost) pi.sendMessage(message, { triggerTurn: false });
	});
	pi.on("session_shutdown", () => {
		queued.clear();
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
