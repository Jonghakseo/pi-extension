import { randomUUID } from "node:crypto";

// Kept package-local so the published extension needs no sibling package.
export const ASYNC_TASK_CHANNEL = "pi.async-tasks.v1";
export interface TaskOwner {
	sessionId: string;
	piSessionId: string;
	runtimeInstanceId: string;
	providerId: string;
	providerInstanceId: string;
}
export interface TrackedTask extends TaskOwner {
	taskId: string;
	rootTaskId: string;
	parentTaskId?: string;
	invocationId?: string;
	kind: string;
	title: string;
	execution: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted";
	presence: "active" | "settled" | "unknown";
	registration: "reserved" | "approved" | "starting" | "spawned" | "abandoned";
	grantId?: string;
	providerRevision: number;
	controlGeneration: number;
	createdAt: string;
	updatedAt: string;
	details?: Record<string, unknown>;
}
interface Ticket extends TaskOwner {
	completionId: string;
	rootTaskId: string;
	target: "model";
	state: "pending" | "submitted" | "suppressed" | "failed";
	controlGeneration: number;
	deliveryId?: string;
	failureReason?: string;
}
export interface ProviderBus {
	on(channel: string, listener: (message: unknown) => void): () => void;
	emit(channel: string, message: unknown): void;
}
interface Hooks {
	cancel(taskId: string): void | Promise<void>;
	detail(taskId: string): string | undefined;
	close(): void;
	reopen?(): void;
	deliveryResumed?(): void;
	observed?(taskIds: string[]): void;
}
type Envelope = Record<string, unknown>;
const capabilities = {
	registration: true,
	snapshot: true,
	cancel: true,
	detail: true,
	closeAdmission: true,
	suppressDelivery: true,
};
const ownerFields = ["sessionId", "piSessionId", "runtimeInstanceId", "providerId", "providerInstanceId"] as const;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

/** Registration is a grant protocol, not an event notification. */
export class AsyncTaskProvider {
	private owner?: TaskOwner;
	private discovery?: { requestId: string; piSessionId: string; providerInstanceId: string };
	private revision = 0;
	private generation = 0;
	private open = false;
	private ready = false;
	private stopped = false;
	private discoveryClosed = false;
	private requestedPiSessionId?: string;
	private bindingEpoch = 0;
	private discoveryPromise?: Promise<void>;
	private resolveDiscovery?: () => void;
	private unsubscribe?: () => void;
	private readonly tasks = new Map<string, TrackedTask>();
	private readonly tickets = new Map<string, Ticket>();
	private readonly payloads = new Map<string, unknown>();
	private readonly observed = new Set<string>();
	private readonly abandoned = new Set<string>();
	private readonly spawned = new Set<string>();
	private readonly pending = new Map<string, { taskId: string; resolve: (message?: Envelope) => void }>();
	private readonly controls = new Map<string, Promise<Envelope>>();

	constructor(
		private readonly bus: ProviderBus | undefined,
		private readonly providerId: string,
		private readonly version: string,
		private readonly hooks: Hooks,
		private readonly timeoutMs = 2_000,
	) {
		this.unsubscribe = bus?.on(ASYNC_TASK_CHANNEL, (message) => this.receive(message));
	}

	bind(piSessionId: string, snapshotReady = true): void {
		if (this.stopped || !isId(piSessionId)) return;
		// A round trip also invalidates starts still awaiting discovery or validation.
		const changedBinding = this.requestedPiSessionId !== piSessionId;
		if (changedBinding) this.bindingEpoch++;
		// Fence new admission even when the old owner must remain for resource callbacks.
		this.requestedPiSessionId = piSessionId;
		if (this.discovery?.piSessionId === piSessionId) {
			if (this.ready !== snapshotReady) {
				this.ready = snapshotReady;
				this.announce();
			}
			if (changedBinding && this.accepting) this.hooks.deliveryResumed?.();
			return;
		}
		// Rebinding a live owner would orphan obligations. Runtime replacement owns that transition.
		if ([...this.tasks.keys()].some((id) => this.retained(id)))
			throw new Error("Async task provider still owns tasks from another session");
		this.tasks.clear();
		this.tickets.clear();
		this.payloads.clear();
		this.observed.clear();
		this.abandoned.clear();
		this.spawned.clear();
		this.revision = 0;
		this.generation = 0;
		this.resolveDiscovery?.();
		this.discoveryClosed = false;
		this.controls.clear();
		this.owner = undefined;
		this.open = false;
		this.ready = snapshotReady;
		this.discovery = { requestId: randomUUID(), piSessionId, providerInstanceId: randomUUID() };
		if (this.bus)
			this.discoveryPromise = new Promise((resolve) => {
				const timer = setTimeout(() => {
					this.discoveryClosed = true;
					resolve();
				}, this.timeoutMs);
				this.resolveDiscovery = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		this.bus?.emit(ASYNC_TASK_CHANNEL, {
			contract: ASYNC_TASK_CHANNEL,
			type: "host-query",
			...this.discovery,
			sessionId: null,
			runtimeInstanceId: null,
			providerId: this.providerId,
			providerRevision: this.revision,
			controlGeneration: this.generation,
		});
	}

	get bindingToken(): number {
		return this.bindingEpoch;
	}

	async whenDiscovered(): Promise<void> {
		await this.discoveryPromise;
	}

	get supported(): boolean {
		return !!this.owner && this.ready;
	}
	get accepting(): boolean {
		return this.supported && this.open && !this.stopped && this.requestedPiSessionId === this.owner?.piSessionId;
	}

	private announce(): void {
		if (!this.owner) return;
		this.emit("provider-ready", {
			providerVersion: this.version,
			contractVersion: 1,
			snapshotReady: this.ready,
			capabilities,
		});
	}

	private emit(type: string, fields: Envelope = {}, requestId: string = randomUUID()): void {
		if (!this.owner) return;
		this.bus?.emit(ASYNC_TASK_CHANNEL, {
			contract: ASYNC_TASK_CHANNEL,
			...this.owner,
			requestId,
			providerRevision: this.revision,
			controlGeneration: this.generation,
			type,
			...fields,
		});
	}

	private snapshot(): { tasks: TrackedTask[]; tickets: Ticket[] } {
		return structuredClone({ tasks: [...this.tasks.values()], tickets: [...this.tickets.values()] });
	}

	private publish(task?: TrackedTask): void {
		this.revision++;
		if (task) {
			task.providerRevision = this.revision;
			task.updatedAt = new Date().toISOString();
		}
		this.emit("task-update", { detail: this.snapshot() });
	}

	private receive(value: unknown): void {
		if (!value || typeof value !== "object") return;
		const message = value as Envelope;
		if (message.contract !== ASYNC_TASK_CHANNEL || !isId(message.requestId)) return;
		if (message.type === "host-state" && this.discovery && !this.owner && !this.discoveryClosed && !this.stopped) {
			if (
				message.requestId !== this.discovery.requestId ||
				message.piSessionId !== this.discovery.piSessionId ||
				message.providerInstanceId !== this.discovery.providerInstanceId ||
				message.providerId !== this.providerId ||
				!isId(message.sessionId) ||
				!isId(message.runtimeInstanceId) ||
				message.supported !== true
			)
				return;
			const offered = message.capabilities as Envelope | undefined;
			if (
				!offered ||
				Object.keys(capabilities).some((key) => offered[key] !== true) ||
				!Number.isSafeInteger(message.controlGeneration) ||
				Number(message.controlGeneration) < 0
			)
				return;
			this.owner = {
				sessionId: message.sessionId,
				runtimeInstanceId: message.runtimeInstanceId,
				piSessionId: this.discovery.piSessionId,
				providerId: this.providerId,
				providerInstanceId: this.discovery.providerInstanceId,
			};
			this.generation = Number(message.controlGeneration);
			this.open = message.admissionState === "open";
			this.resolveDiscovery?.();
			this.announce();
			return;
		}
		if (!this.owner || ownerFields.some((key) => message[key] !== this.owner?.[key])) return;
		if (
			message.type === "host-state" &&
			Number.isSafeInteger(message.controlGeneration) &&
			Number(message.controlGeneration) > this.generation
		) {
			this.generation = Number(message.controlGeneration);
			this.open = !this.stopped && message.supported === true && message.admissionState === "open";
			if (this.open) this.hooks.reopen?.();
			return;
		}
		if (message.type === "task-register-result") {
			const pending = this.pending.get(message.requestId);
			if (pending && pending.taskId === message.taskId) pending.resolve(message);
		} else if (message.type === "snapshot-request") {
			this.emit("snapshot", { watermark: this.revision, detail: this.snapshot() }, message.requestId);
		} else if (
			message.type === "completion-observed" &&
			isId(message.deliveryId) &&
			Array.isArray(message.completionIds)
		) {
			for (const id of message.completionIds) {
				const ticket = typeof id === "string" ? this.tickets.get(id) : undefined;
				if (ticket?.deliveryId === message.deliveryId) this.observed.add(ticket.completionId);
			}
			const deliveryTickets = [...this.tickets.values()].filter((ticket) => ticket.deliveryId === message.deliveryId);
			if (deliveryTickets.length && deliveryTickets.every((ticket) => this.observed.has(ticket.completionId))) {
				this.payloads.delete(message.deliveryId);
				this.hooks.observed?.(deliveryTickets.map((ticket) => ticket.rootTaskId));
			}
		} else if (message.type === "control-request") {
			let operation = this.controls.get(message.requestId);
			if (!operation) {
				operation = this.control(message).catch((error: unknown) => ({
					outcome: "blocked_cleanup",
					admissionClosed: !this.open,
					submittedDeliveryIds: [],
					reason: String(error).slice(0, 4096),
				}));
				this.controls.set(message.requestId, operation);
			}
			const owner = this.owner;
			void operation.then((result) => {
				if (this.owner === owner) this.emit("control-result", result, String(message.requestId));
			});
		}
	}

	private request(type: string, taskId: string, fields: Envelope = {}): Promise<Envelope | undefined> {
		if (this.pending.size >= 128) return Promise.resolve(undefined);
		const requestId = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => finish(), this.timeoutMs);
			const finish = (reply?: Envelope) => {
				clearTimeout(timer);
				this.pending.delete(requestId);
				resolve(reply);
			};
			this.pending.set(requestId, { taskId, resolve: finish });
			this.emit(type, { taskId, ...fields }, requestId);
		});
	}

	async reserve(
		input: {
			taskId?: string;
			rootTaskId?: string;
			title: string;
			kind: string;
			details?: Record<string, unknown>;
			invocationId?: string;
		},
		signal?: AbortSignal,
	): Promise<string | undefined> {
		const owner = this.owner;
		const binding = this.bindingToken;
		if (!this.supported || !owner) return undefined;
		if (!this.accepting || signal?.aborted) throw new Error("Async task admission is closed");
		const taskId = input.taskId ?? randomUUID();
		if (this.pending.size >= 128) throw new Error("Async task registration request limit reached");
		if (!isId(taskId) || !isId(input.kind) || (input.invocationId !== undefined && !isId(input.invocationId)))
			throw new Error("Invalid async task identity");
		if (this.tasks.has(taskId)) throw new Error("Async task attempt already exists");
		if (input.rootTaskId && !this.tasks.has(input.rootTaskId)) throw new Error("Async task root is missing");
		const now = new Date().toISOString();
		const task: TrackedTask = {
			...owner,
			taskId,
			rootTaskId: input.rootTaskId ?? taskId,
			...(input.rootTaskId ? { parentTaskId: input.rootTaskId } : {}),
			...(input.invocationId ? { invocationId: input.invocationId } : {}),
			kind: input.kind,
			title: input.title.slice(0, 500) || input.kind,
			execution: "queued",
			presence: "settled",
			registration: "reserved",
			providerRevision: ++this.revision,
			controlGeneration: this.generation,
			createdAt: now,
			updatedAt: now,
			...(input.details ? { details: input.details } : {}),
		};
		if (Buffer.byteLength(JSON.stringify(task.details ?? {})) > 16_384)
			throw new Error("Async task details exceed wire limit");
		this.tasks.set(taskId, task);
		const onAbort = () => {
			this.abandoned.add(taskId);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// task-register has task, not taskId, in the frozen wire contract.
			let reply = await this.register(task);
			if (!reply && !this.abandoned.has(taskId) && this.accepting && this.bindingToken === binding)
				reply = await this.request("registration-query", taskId);
			if (
				this.bindingToken !== binding ||
				reply?.outcome !== "accepted" ||
				reply.registration !== "approved" ||
				!isId(reply.grantId) ||
				reply.controlGeneration !== task.controlGeneration ||
				!this.accepting ||
				this.generation !== task.controlGeneration ||
				this.abandoned.has(taskId)
			) {
				await this.abandon(taskId);
				throw new Error("Async task registration was not approved; execution did not start");
			}
			task.registration = "approved";
			task.grantId = reply.grantId;
			task.presence = "active";
			this.publish(task);
			return taskId;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	private register(task: TrackedTask): Promise<Envelope | undefined> {
		const requestId = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => finish(), this.timeoutMs);
			const finish = (reply?: Envelope) => {
				clearTimeout(timer);
				this.pending.delete(requestId);
				resolve(reply);
			};
			this.pending.set(requestId, { taskId: task.taskId, resolve: finish });
			this.emit("task-register", { task: structuredClone(task) }, requestId);
		});
	}

	async abandon(taskId: string): Promise<void> {
		const task = this.tasks.get(taskId);
		if (!task || this.spawned.has(taskId)) return;
		this.abandoned.add(taskId);
		const reply = await this.request("registration-abandon", taskId, { neverSpawned: true });
		if (reply?.registration === "abandoned") {
			task.registration = "abandoned";
			task.execution = "cancelled";
			task.presence = "settled";
		} else {
			task.execution = "interrupted";
			task.presence = "unknown";
		}
		this.publish(task);
	}

	canStart(taskId: string): boolean {
		const task = this.tasks.get(taskId);
		return (
			!!task &&
			this.accepting &&
			task.controlGeneration === this.generation &&
			!this.abandoned.has(taskId) &&
			!this.spawned.has(taskId) &&
			task.registration === "approved"
		);
	}

	start(taskId: string): boolean {
		if (!this.canStart(taskId)) return false;
		this.spawned.add(taskId);
		const task = this.tasks.get(taskId);
		if (!task) return false;
		task.registration = "starting";
		task.execution = "running";
		// Do not call external listeners between consuming the grant and entering
		// the executor. The first resource/result event publishes this revision.
		task.providerRevision = ++this.revision;
		task.updatedAt = new Date().toISOString();
		return true;
	}

	resource(taskId: string, presence: TrackedTask["presence"]): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		task.presence = presence;
		if (presence === "active") task.registration = "spawned";
		this.publish(task);
	}

	finish(
		taskId: string,
		execution: TrackedTask["execution"],
		presence: TrackedTask["presence"],
		completion = true,
	): void {
		const task = this.tasks.get(taskId);
		const owner = this.owner;
		if (!task || !owner) return;
		task.execution = execution;
		task.presence = presence;
		if (
			completion &&
			task.rootTaskId === taskId &&
			![...this.tickets.values()].some((ticket) => ticket.rootTaskId === taskId)
		) {
			const ticket: Ticket = {
				...owner,
				completionId: randomUUID(),
				rootTaskId: taskId,
				target: "model",
				state:
					this.supported && this.open && !this.stopped && task.controlGeneration === this.generation
						? "pending"
						: "suppressed",
				controlGeneration: task.controlGeneration,
			};
			this.tickets.set(ticket.completionId, ticket);
		}
		this.publish(task);
	}

	discardPending(taskId: string): void {
		for (const ticket of this.tickets.values()) {
			if (ticket.rootTaskId === taskId && !ticket.deliveryId) ticket.state = "suppressed";
		}
		this.publish();
	}

	failPending(taskId: string, reason: string): void {
		for (const ticket of this.tickets.values()) {
			if (ticket.rootTaskId === taskId && ticket.state === "pending") {
				ticket.state = "failed";
				ticket.failureReason = reason.slice(0, 4096);
			}
		}
		this.publish();
	}

	retained(taskId: string): boolean {
		const task = this.tasks.get(taskId);
		return (
			!!task &&
			(task.registration === "reserved" ||
				task.presence !== "settled" ||
				[...this.tickets.values()].some(
					(ticket) =>
						ticket.rootTaskId === task.rootTaskId &&
						ticket.state !== "suppressed" &&
						!this.observed.has(ticket.completionId),
				))
		);
	}

	/** Never-sent payloads stay in the batcher until their owner can receive them. */
	deliveryState(taskId: string): "send" | "hold" | "discard" {
		if (!this.tasks.has(taskId)) return "send";
		const ticket = [...this.tickets.values()].find((ticket) => ticket.rootTaskId === taskId);
		if (ticket?.state !== "pending" || ticket.controlGeneration !== this.generation) return "discard";
		return this.accepting ? "send" : "hold";
	}

	deliver<T extends { details?: unknown }>(taskIds: string[], message: T, send: (message: T) => void): void {
		const tickets = [...this.tickets.values()].filter(
			(ticket) => taskIds.includes(ticket.rootTaskId) && ticket.state === "pending",
		);
		if (!tickets.length) {
			if (!taskIds.some((id) => this.tasks.has(id))) {
				try {
					send(message);
				} catch {
					/* Preserve unsupported hosts' best-effort delivery. */
				}
			}
			return;
		}
		if (!this.accepting || tickets.some((ticket) => ticket.controlGeneration !== this.generation)) return;
		const owner = this.owner;
		if (!owner) return;
		const deliveryId = randomUUID();
		const annotated = {
			...message,
			details: {
				...(message.details && typeof message.details === "object" ? message.details : {}),
				asyncTasks: {
					...owner,
					deliveryId,
					completionIds: tickets.map((ticket) => ticket.completionId),
					taskIds,
					controlGeneration: this.generation,
				},
			},
		};
		this.payloads.set(deliveryId, annotated);
		for (const ticket of tickets) {
			ticket.state = "submitted";
			ticket.deliveryId = deliveryId;
		}
		const deliveryGeneration = this.generation;
		this.publish();
		if (!this.accepting || this.generation !== deliveryGeneration) {
			for (const ticket of tickets) ticket.state = "suppressed";
			this.payloads.delete(deliveryId);
			this.publish();
			return;
		}
		try {
			send(annotated);
		} catch (error) {
			for (const ticket of tickets) {
				ticket.state = "failed";
				ticket.failureReason = String(error).slice(0, 4096);
			}
			this.publish();
		}
	}

	private async control(message: Envelope): Promise<Envelope> {
		const base = () => ({
			admissionClosed: !this.open,
			submittedDeliveryIds: [
				...new Set([...this.tickets.values()].flatMap((ticket) => (ticket.deliveryId ? [ticket.deliveryId] : []))),
			],
		});
		if (!Number.isSafeInteger(message.controlGeneration) || Number(message.controlGeneration) < this.generation)
			return { ...base(), outcome: "stale" };
		if (message.action === "closeAdmission") {
			this.open = false;
			this.generation = Number(message.controlGeneration);
			this.hooks.close();
			for (const task of this.tasks.values())
				if (!this.spawned.has(task.taskId)) {
					this.abandoned.add(task.taskId);
					void this.abandon(task.taskId);
				}
			for (const ticket of this.tickets.values())
				if (ticket.state === "pending" || (ticket.state === "failed" && !ticket.deliveryId))
					ticket.state = "suppressed";
			this.publish();
			return { ...base(), outcome: "settled" };
		}
		if (message.controlGeneration !== this.generation) return { ...base(), outcome: "stale" };
		if (message.action === "suppressDelivery" && Array.isArray(message.deliveryIds)) {
			for (const ticket of this.tickets.values())
				if (ticket.deliveryId && message.deliveryIds.includes(ticket.deliveryId)) {
					ticket.state = "suppressed";
					this.payloads.delete(ticket.deliveryId);
				}
			this.publish();
			return { ...base(), outcome: "settled" };
		}
		const taskId = typeof message.taskId === "string" ? message.taskId : "";
		const task = this.tasks.get(taskId);
		if (!task) return { ...base(), outcome: "rejected", reason: "Unknown task" };
		if (message.action === "detail")
			return { ...base(), outcome: "settled", detail: (this.hooks.detail(taskId) ?? "").slice(0, 4096) };
		if (message.action !== "cancel") return { ...base(), outcome: "unsupported" };
		task.execution = "cancelling";
		this.publish(task);
		if (!this.spawned.has(taskId)) await this.abandon(taskId);
		try {
			await this.hooks.cancel(taskId);
		} catch (error) {
			return { ...base(), outcome: "blocked_cleanup", reason: String(error).slice(0, 4096) };
		}
		return {
			...base(),
			outcome: task.presence === "settled" ? "settled" : task.presence === "unknown" ? "blocked_cleanup" : "accepted",
		};
	}

	shutdown(): void {
		this.open = false;
		this.stopped = true;
		this.bindingEpoch++;
		this.resolveDiscovery?.();
		this.hooks.close();
		for (const pending of this.pending.values()) pending.resolve();
		for (const ticket of this.tickets.values())
			if (ticket.state === "pending" || (ticket.state === "failed" && !ticket.deliveryId)) ticket.state = "suppressed";
		this.publish();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}
