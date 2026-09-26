import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AsyncTaskProvider, type TrackedTask } from "./async-task-provider.js";
import type { SingleResult } from "./types.js";

type Presence = TrackedTask["presence"];
interface Invocation {
	lifecycle: SubagentAsyncTasks;
	id: string;
	controller: AbortController;
	hidden: boolean;
	children: Map<string, Presence>;
	result?: TrackedTask["execution"];
}
const invocations = new AsyncLocalStorage<Invocation>();
const resources = new AsyncLocalStorage<(presence: Presence) => void>();

export function currentResourceObserver(): (presence: Presence) => void {
	return resources.getStore() ?? (() => {});
}

/** Captured before the runner's first await; callbacks retain the original attempt. */
export async function trackSubagentRunner(
	title: string,
	signal: AbortSignal | undefined,
	run: (signal: AbortSignal | undefined) => Promise<SingleResult>,
	runId?: number,
): Promise<SingleResult> {
	const invocation = invocations.getStore();
	if (!invocation) return run(signal);
	const { lifecycle, controller } = invocation;
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	if (combined.aborted) throw new Error("Subagent was aborted");
	const id = await lifecycle.provider.reserve(
		{ title, kind: "subagent", rootTaskId: invocation.id, details: runId === undefined ? undefined : { runId } },
		combined,
	);
	if (!id) throw new Error("Subagent registration unavailable");
	if (combined.aborted || !lifecycle.provider.start(id)) {
		await lifecycle.provider.abandon(id);
		throw new Error("Subagent admission closed before execution");
	}
	invocation.children.set(id, "unknown");
	let presence: Presence = "unknown";
	const observe = (next: Presence) => {
		presence = next;
		invocation.children.set(id, next);
		lifecycle.provider.resource(id, next);
		lifecycle.updatePresence(invocation);
	};
	try {
		const result = await resources.run(observe, () => run(combined));
		lifecycle.provider.finish(
			id,
			result.stopReason === "aborted" || combined.aborted
				? "cancelled"
				: result.exitCode === 0
					? "succeeded"
					: "failed",
			presence,
			false,
		);
		return result;
	} catch (error) {
		lifecycle.provider.finish(id, combined.aborted ? "cancelled" : "failed", presence, false);
		throw error;
	}
}

export function assertAsyncAdmission(): void {
	const invocation = invocations.getStore();
	if (invocation && (invocation.controller.signal.aborted || !invocation.lifecycle.provider.accepting))
		throw new Error("Subagent was aborted");
}

export function completeAsyncInvocation(status: string): void {
	const invocation = invocations.getStore();
	if (!invocation || invocation.result) return;
	invocation.result =
		invocation.controller.signal.aborted || status === "aborted"
			? "cancelled"
			: status === "completed" || status === "done"
				? "succeeded"
				: "failed";
	invocation.lifecycle.finish(invocation);
}

export function discardRemovedAsyncInvocation(content: string): void {
	const root = invocations.getStore();
	if (!root) return;
	completeAsyncInvocation("aborted");
	root.lifecycle.retain(root.id, { content });
	root.lifecycle.discardPending(root.id);
}

/** Only a host-cancelled invocation may omit its redundant abort notice. */
export function isExpectedTrackedCancellation(): boolean {
	return invocations.getStore()?.controller.signal.aborted === true;
}

export function asyncInvocationDetails(): Record<string, string> {
	const invocation = invocations.getStore();
	return invocation ? { asyncTaskRootId: invocation.id } : {};
}

export function retainAsyncCompletion<T extends { content: unknown; details?: unknown }>(message: T): T {
	const root = invocations.getStore();
	if (root) root.lifecycle.retain(root.id, message);
	return message;
}

export class SubagentAsyncTasks {
	readonly provider: AsyncTaskProvider;
	private boundPiSessionId?: string;
	private readonly roots = new Map<string, Invocation>();
	private readonly outputs = new Map<string, string>();
	private readonly pendingPayloads = new Map<string, unknown>();
	private readonly wrapped = new WeakSet<ExtensionAPI>();

	constructor(pi: ExtensionAPI) {
		this.provider = new AsyncTaskProvider(pi.events, "subagent", "0.5.7", {
			cancel: (id) => {
				const root = this.roots.get(id);
				if (!root) throw new Error("Only group-root cancellation is supported");
				root.controller.abort();
			},
			detail: (id) => this.outputs.get(id),
			observed: (ids) => {
				for (const id of ids) this.pendingPayloads.delete(id);
			},
			close: () => {
				this.pendingPayloads.clear();
				// Abort also fences retry and chain admission, not merely the current process.
				for (const root of this.roots.values()) root.controller.abort();
			},
		});
	}

	bind(piSessionId: string): void {
		this.provider.bind(piSessionId);
		if (this.boundPiSessionId !== piSessionId) {
			this.roots.clear();
			this.outputs.clear();
			this.pendingPayloads.clear();
			this.boundPiSessionId = piSessionId;
		}
	}

	async invoke<T>(
		title: string,
		invocationId: string | undefined,
		run: () => Promise<T>,
		hidden = false,
		signal?: AbortSignal,
	): Promise<T> {
		const binding = this.provider.bindingToken;
		await this.provider.whenDiscovered();
		if (this.provider.bindingToken !== binding) throw new Error("Subagent session changed before invocation");
		if (invocations.getStore() || !this.provider.supported) return run();
		const id = await this.provider.reserve({ title, kind: "subagent", invocationId }, signal);
		if (!id) throw new Error("Subagent registration unavailable");
		if (signal?.aborted || !this.provider.start(id)) {
			await this.provider.abandon(id);
			throw new Error("Subagent admission closed before invocation");
		}
		const root: Invocation = { id, lifecycle: this, controller: new AbortController(), hidden, children: new Map() };
		this.roots.set(id, root);
		return invocations.run(root, async () => {
			try {
				const result = await run();
				// Validation can reject before a runner starts. Do not leave a phantom root.
				if (
					result &&
					typeof result === "object" &&
					"isError" in result &&
					result.isError === true &&
					root.children.size === 0
				) {
					root.result = "failed";
					this.provider.finish(id, "failed", "settled", false);
				}
				return result;
			} catch (error) {
				root.result = root.controller.signal.aborted ? "cancelled" : "failed";
				this.provider.finish(id, root.result, this.presence(root), false);
				throw error;
			}
		});
	}

	private presence(root: Invocation): Presence {
		const children = [...root.children.values()];
		if (children.includes("active")) return "active";
		return children.includes("unknown") ? "unknown" : root.result ? "settled" : "active";
	}

	updatePresence(root: Invocation): void {
		this.provider.resource(root.id, this.presence(root));
	}

	finish(root: Invocation): void {
		if (root.result) this.provider.finish(root.id, root.result, this.presence(root), !root.hidden);
	}

	shutdown(): void {
		this.provider.shutdown();
		for (const root of this.roots.values()) {
			if (!root.result) root.result = "interrupted";
			this.finish(root);
		}
	}

	retain(id: string, message: { content: unknown }): void {
		if (!this.roots.get(id)?.hidden) this.pendingPayloads.set(id, structuredClone(message));
		this.outputs.set(
			id,
			(typeof message.content === "string" ? message.content : JSON.stringify(message.content)).slice(0, 4096),
		);
	}

	discardPending(id: string): void {
		this.provider.discardPending(id);
		this.pendingPayloads.delete(id);
	}

	expirePending(message: { details?: unknown }): void {
		const details = message.details as Record<string, unknown> | undefined;
		if (typeof details?.asyncTaskRootId === "string" && this.roots.has(details.asyncTaskRootId)) {
			this.provider.failPending(
				details.asyncTaskRootId,
				"Automatic delivery expired while the origin session was inactive; result is retained for inspection.",
			);
		}
	}

	wrap(pi: ExtensionAPI): ExtensionAPI {
		if (this.wrapped.has(pi)) return pi;
		const proxy = new Proxy(pi, {
			get: (target, property, receiver) => {
				if (property !== "sendMessage") return Reflect.get(target, property, receiver);
				const send: ExtensionAPI["sendMessage"] = (message, options) => {
					const details =
						message.details && typeof message.details === "object" ? (message.details as Record<string, unknown>) : {};
					const rootId =
						typeof details.asyncTaskRootId === "string" ? details.asyncTaskRootId : invocations.getStore()?.id;
					const root = rootId ? this.roots.get(rootId) : undefined;
					// A persisted completion from another provider instance must never auto-replay.
					if (typeof details.asyncTaskRootId === "string" && !root) return;
					if (!root || options?.triggerTurn === false || (!root.result && options?.triggerTurn !== true)) {
						target.sendMessage(message, options);
						return;
					}
					if (root.hidden) return;
					if (!root.result) {
						root.result = "succeeded";
						this.finish(root);
					}
					this.outputs.set(
						root.id,
						(typeof message.content === "string" ? message.content : JSON.stringify(message.content)).slice(0, 4096),
					);
					this.provider.deliver([root.id], message, (annotated) => target.sendMessage(annotated, options));
				};
				return send;
			},
		});
		this.wrapped.add(proxy);
		return proxy;
	}
}
