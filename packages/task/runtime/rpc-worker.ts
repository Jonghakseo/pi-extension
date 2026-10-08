/**
 * Parent side of a Task worker: one long-lived Pi process per Task, driven over RPC.
 *
 * The process outlives a single turn on purpose. A worker that started a background job settles its
 * turn, keeps the job, and wakes up when the job completes. Editing a Task aborts the model run and
 * sends new instructions into the same process, so detached work and tool state survive the edit.
 * Only a validated `task_report` tool result finishes a revision.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSelection, TaskWorker, WorkerEvents, WorkerFactory, WorkerInput, WorkerOptions } from "../types.js";
import {
	ENV_TASK_CONTEXT_FILE,
	ENV_TASK_ID,
	ENV_TASK_READONLY,
	ENV_TASK_REVISION,
	ENV_WORKER_MARKER,
	parseTaskReportDetails,
	RECURSIVE_TOOL_NAMES,
	TASK_REPORT_TOOL,
	WORKER_CONTROL_COMMAND,
} from "./protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const STDIN_CLOSE_GRACE_MS = 10_000;
const SIGTERM_GRACE_MS = 5_000;
const SIGKILL_GRACE_MS = 2_000;
/** Enough stderr to explain a startup failure, not enough to grow without bound. */
const STDERR_LIMIT = 16_384;

interface PendingRequest {
	resolve(data: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

interface RpcResponse {
	type: "response";
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
	data?: unknown;
}

function isResponse(record: unknown): record is RpcResponse {
	return typeof record === "object" && record !== null && (record as { type?: unknown }).type === "response";
}

const CLI_PACKAGE = "@earendil-works/pi-coding-agent";

function readManifest(root: string): { name?: string; bin?: string | Record<string, string> } | undefined {
	try {
		return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			name?: string;
			bin?: string | Record<string, string>;
		};
	} catch {
		return undefined;
	}
}

/** The CLI entry of an unpacked pi-coding-agent, or undefined when `root` is something else. */
function cliInPackage(root: string): string | undefined {
	const manifest = readManifest(root);
	if (manifest?.name !== CLI_PACKAGE) return undefined;
	const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
	const candidates = [
		bin ? join(root, bin) : undefined,
		join(root, "dist", "bundle", "cli.js"),
		join(root, "dist", "cli.js"),
	];
	return candidates.find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));
}

/**
 * The installed Pi CLI, never resolved through a shell. The package's `exports` map has no `require`
 * condition, so this walks `node_modules` instead of asking the CommonJS resolver.
 */
export function resolveCliPath(explicit?: string): string {
	if (explicit) {
		if (!existsSync(explicit)) throw new Error(`Task worker CLI not found: ${explicit}`);
		return explicit;
	}
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const found = cliInPackage(join(dir, "node_modules", ...CLI_PACKAGE.split("/")));
		if (found) return found;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Last resort: the CLI that runs this process, but only when it really is one.
	const current = process.argv[1];
	if (current && existsSync(current)) {
		let candidate = dirname(current);
		for (;;) {
			if (existsSync(join(candidate, "package.json"))) {
				if (readManifest(candidate)?.name === CLI_PACKAGE) return current;
				break;
			}
			const parent = dirname(candidate);
			if (parent === candidate) break;
			candidate = parent;
		}
	}
	throw new Error(`Cannot resolve the pi CLI for Task workers. Install ${CLI_PACKAGE} or pass cliPath.`);
}

/** The private bridge extension, shipped next to this file. */
function resolveBridgePath(): string {
	for (const name of ["worker-bridge.ts", "worker-bridge.js"]) {
		const candidate = fileURLToPath(new URL(name, import.meta.url));
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("The Task worker bridge extension is missing from the package.");
}

class RpcWorker implements TaskWorker {
	private child: ChildProcess | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private stdout = "";
	private stderr = "";
	private sequence = 0;
	private exited = false;
	private exitReason: string | undefined;
	private stopping = false;
	private stopPromise: Promise<void> | undefined;
	private waitForExit: Promise<void> = Promise.resolve();
	private signalExit: () => void = () => {};
	/** The revision reports are accepted for. Moved before any await in `update()`. */
	private activeRevision = 0;
	private readyRevision = 0;
	private promptMarker = "";
	private finalModelError: string | undefined;
	private readonly reported = new Set<number>();

	constructor(
		private readonly options: WorkerOptions,
		private readonly events: WorkerEvents,
	) {}

	async start(input: WorkerInput): Promise<void> {
		if (this.child) throw new Error(`Task worker ${this.options.taskId} is already running`);
		if (this.stopping) throw new Error(`Task worker ${this.options.taskId} is shutting down`);
		this.activeRevision = input.revision;
		this.spawnChild(input.revision);
		try {
			await this.request("get_state");
			await this.applySelection(input.selection);
			await this.activate(input.revision);
			await this.sendPrompt(input.prompt);
		} catch (error) {
			// A half-started worker is not usable, and nobody else owns this process yet.
			await this.stop().catch(() => {});
			throw error;
		}
	}

	/**
	 * New instructions for a running worker. The fence moves first so a report the child is already
	 * producing for the previous revision cannot finish the new one; the model run is then aborted
	 * while its detached background jobs keep running.
	 */
	async update(input: WorkerInput): Promise<void> {
		this.activeRevision = input.revision;
		this.readyRevision = 0;
		this.requireChild();
		await this.request("clear_queue");
		await this.request("abort");
		await this.applySelection(input.selection);
		await this.activate(input.revision);
		await this.sendPrompt(input.prompt);
	}

	/** Interrupts the model run only. The RPC session and its background jobs stay alive. */
	async abort(): Promise<void> {
		if (!this.child || this.exited || this.stopping) return;
		await this.request("clear_queue");
		await this.request("abort");
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.stopPromise ??= this.shutdown();
		return this.stopPromise;
	}

	private spawnChild(revision: number): void {
		const cliPath = resolveCliPath(this.options.cliPath);
		const bridgePath = resolveBridgePath();
		const args = [
			cliPath,
			"--mode",
			"rpc",
			"--session",
			this.options.sessionFile,
			"--exclude-tools",
			RECURSIVE_TOOL_NAMES.join(","),
			"--extension",
			bridgePath,
			...(this.options.extraArgs ?? []),
		];
		const env: NodeJS.ProcessEnv = {
			...(this.options.env ?? process.env),
			[ENV_WORKER_MARKER]: "1",
			[ENV_TASK_ID]: this.options.taskId,
			[ENV_TASK_REVISION]: String(revision),
			[ENV_TASK_CONTEXT_FILE]: this.options.contextFile,
			[ENV_TASK_READONLY]: this.options.readonly ? "1" : "0",
		};
		this.waitForExit = new Promise<void>((resolve) => {
			this.signalExit = resolve;
		});
		const child = spawn(this.options.nodePath ?? process.execPath, args, {
			cwd: this.options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		this.child = child;
		child.stdin?.on("error", (error) => {
			if (!this.stopping && !this.exited) this.events.onError(`Task worker stdin failed: ${error.message}`);
		});
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.readStdout(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
		});
		child.on("error", (error) => this.handleExit(`Task worker process error: ${error.message}`));
		child.on("exit", (code, signal) => {
			const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			this.handleExit(code === 0 && !signal ? undefined : `Task worker stopped with ${detail}.${this.stderrTail()}`);
		});
	}

	private stderrTail(): string {
		const tail = this.stderr.trim();
		return tail ? ` Last output: ${tail.slice(-1_000)}` : "";
	}

	private handleExit(reason: string | undefined): void {
		if (this.exited) return;
		this.exited = true;
		this.exitReason = reason;
		const failure = new Error(reason ?? `Task worker ${this.options.taskId} exited`);
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			this.pending.delete(id);
			request.reject(failure);
		}
		this.signalExit();
		// A planned stop is not a failure: the manager closes workers after a report and at shutdown.
		if (!this.stopping) this.events.onExit(reason);
	}

	private readStdout(chunk: string): void {
		this.stdout += chunk;
		// Strict LF framing: only "\n" ends a record, and a JSON string may contain U+2028/U+2029.
		let newline = this.stdout.indexOf("\n");
		while (newline !== -1) {
			const line = this.stdout.slice(0, newline).replace(/\r$/, "");
			this.stdout = this.stdout.slice(newline + 1);
			if (line.trim()) this.handleLine(line);
			newline = this.stdout.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			this.events.onError(`Task worker emitted a non-protocol line: ${line.slice(0, 200)}`);
			return;
		}
		if (isResponse(record)) {
			this.settleResponse(record);
			return;
		}
		this.handleEvent(record);
	}

	private settleResponse(record: RpcResponse): void {
		if (!record.id) {
			if (record.success === false)
				this.events.onError(`Task worker rejected a command: ${record.error ?? "unknown error"}`);
			return;
		}
		const request = this.pending.get(record.id);
		if (!request) return;
		this.pending.delete(record.id);
		clearTimeout(request.timer);
		if (record.success) request.resolve(record.data);
		else request.reject(new Error(record.error ?? `Task worker rejected ${record.command ?? "a command"}`));
	}

	private handleEvent(record: unknown): void {
		if (!record || typeof record !== "object") return;
		const event = record as {
			type?: string;
			toolName?: string;
			isError?: boolean;
			result?: { details?: unknown };
			aborted?: boolean;
			id?: string;
			method?: string;
			message?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown };
		};
		switch (event.type) {
			case "agent_start":
				this.finalModelError = undefined;
				this.events.onActivity("running");
				return;
			case "message_end": {
				const message = event.message;
				if (
					message?.role === "user" &&
					this.promptMarker &&
					JSON.stringify(message.content).includes(this.promptMarker)
				) {
					// Prompt acceptance alone is insufficient: queued input must actually enter the child run.
					this.readyRevision = this.activeRevision;
					this.finalModelError = undefined;
				}
				if (message?.role === "assistant")
					this.finalModelError =
						message.stopReason === "error"
							? message.errorMessage || "Worker model failed before task_report"
							: undefined;
				return;
			}
			// Wait for Pi's retries/recovery to settle before treating a provider error as final.
			case "agent_settled":
				if (!event.aborted && this.finalModelError && this.readyRevision === this.activeRevision) {
					this.events.onError(this.finalModelError);
				} else this.events.onActivity("waiting");
				return;
			case "extension_ui_request":
				if (event.id && ["select", "confirm", "input", "editor"].includes(event.method ?? "")) {
					this.child?.stdin?.write(
						`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`,
					);
					this.events.onError(
						"Worker requested interactive input. Supply the missing decision through a Task edit; it was not automatically approved.",
					);
				}
				return;
			case "tool_execution_end":
				this.acceptReport(event);
				return;
			default:
				return;
		}
	}

	private acceptReport(event: { toolName?: string; isError?: boolean; result?: { details?: unknown } }): void {
		if (event.toolName !== TASK_REPORT_TOOL || event.isError) return;
		const report = parseTaskReportDetails(event.result?.details, this.options.taskId);
		// A stale report, a report for another Task, or a hand-written details object is not a result.
		if (
			!report ||
			report.revision !== this.activeRevision ||
			this.readyRevision !== report.revision ||
			this.reported.has(report.revision)
		)
			return;
		this.reported.add(report.revision);
		this.events.onReport(report);
	}

	private requireChild(): ChildProcess {
		if (!this.child || this.exited) {
			throw new Error(this.exitReason ?? `Task worker ${this.options.taskId} is not running`);
		}
		return this.child;
	}

	private request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
		const child = this.requireChild();
		const id = `task-${++this.sequence}`;
		const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Task worker did not answer ${type} within ${Math.round(timeoutMs / 1_000)}s`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
				if (!error) return;
				const request = this.pending.get(id);
				if (!request) return;
				this.pending.delete(id);
				clearTimeout(timer);
				request.reject(new Error(`Task worker stdin failed: ${error.message}`));
			});
		});
	}

	private async applySelection(selection: ModelSelection): Promise<void> {
		await this.request("set_model", { provider: selection.provider, modelId: selection.model });
		await this.request("set_thinking_level", { level: selection.thinking });
	}

	private async activate(revision: number): Promise<void> {
		const payload = JSON.stringify({ op: "activate", revision });
		const data = await this.request("prompt", { message: `/${WORKER_CONTROL_COMMAND} ${payload}` });
		const disposition = (data as { disposition?: string } | undefined)?.disposition;
		if (disposition !== "handled") {
			throw new Error(
				`The Task worker bridge did not take revision ${revision} (disposition ${disposition ?? "none"})`,
			);
		}
	}

	private async sendPrompt(message: string): Promise<void> {
		// "steer" only matters if a background completion woke the child between abort and prompt.
		this.promptMarker = `task-input-${randomUUID()}`;
		const data = await this.request("prompt", {
			message: `${message}\n\n[${this.promptMarker}]`,
			streamingBehavior: "steer",
		});
		const disposition = (data as { disposition?: string } | undefined)?.disposition;
		if (disposition !== "started" && disposition !== "queued") {
			throw new Error(`The Task worker did not accept its instructions (disposition ${disposition ?? "none"})`);
		}
		this.events.onActivity("running");
	}

	/** Closing stdin lets the child's own extensions release their resources before it exits. */
	private async shutdown(): Promise<void> {
		const child = this.child;
		if (!child || this.exited) return;
		for (const [id, request] of this.pending) {
			clearTimeout(request.timer);
			this.pending.delete(id);
			request.reject(new Error(`Task worker ${this.options.taskId} is shutting down`));
		}
		try {
			child.stdin?.end();
		} catch {
			// Already closed; the signal escalation below still applies.
		}
		if (await this.exitedWithin(STDIN_CLOSE_GRACE_MS)) return;
		child.kill("SIGTERM");
		if (await this.exitedWithin(SIGTERM_GRACE_MS)) return;
		child.kill("SIGKILL");
		await this.exitedWithin(SIGKILL_GRACE_MS);
	}

	private exitedWithin(ms: number): Promise<boolean> {
		if (this.exited) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(this.exited), ms);
			timer.unref?.();
			void this.waitForExit.then(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}
}

export const createRpcWorker: WorkerFactory = (options, events) => new RpcWorker(options, events);
