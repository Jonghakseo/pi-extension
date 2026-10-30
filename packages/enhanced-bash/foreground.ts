import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionAdapter } from "./background/job-manager.js";
import { resolveShellOptions, withFailureHints } from "./platform.js";

const DETACHED = "enhanced-bash:detached";
/**
 * Output kept for the background log once a command moves there. Older output beyond this is dropped: the
 * log gets a marker line in its place, and only the tool result's last lines show what came before.
 */
export const MAX_ADOPTED_BACKLOG_BYTES = 1024 * 1024;
/** setTimeout stores its delay in 32 bits, and a larger value fires after 1ms instead of waiting. */
export const MAX_TIMER_SECONDS = 2_147_483;
const RECENT_LINES = 20;
const BACKLOG_DROPPED_MARKER = Buffer.from("[earlier output omitted when the command moved to the background]\n");

export interface AdoptRequest {
	command: string;
	title: string;
	waitedSeconds: number;
	/** Last lines printed before the move, including an unterminated final line. */
	recentLines: string[];
	execute: ExecutionAdapter;
	/** The call's abort signal, so an interrupt that lands during adoption still cancels the job. */
	signal?: AbortSignal;
}

export interface ForegroundRequest {
	toolCallId: string;
	command: string;
	title: string;
	/** Seconds to wait before the command moves to the background. 0 waits without limit. */
	waitSeconds: number;
	/** Seconds an adopted command may keep running in the background. 0 disables the limit. */
	backgroundTimeoutSeconds: number;
	context: ExtensionToolContext;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<unknown>;
	adopt: (request: AdoptRequest) => Promise<AgentToolResult<unknown>>;
	/** Test seam for the shell backend. */
	operations?: BashOperations;
}

/**
 * Keeps the tail of the output seen before a command moves to the background, so the job log starts with
 * the lines that led up to it instead of whatever arrives after the move.
 */
class Backlog {
	private chunks: Buffer[] = [];
	private bytes = 0;
	private dropped = false;

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		while (this.bytes > MAX_ADOPTED_BACKLOG_BYTES && this.chunks.length > 1) {
			const removed = this.chunks.shift();
			this.bytes -= removed?.length ?? 0;
			this.dropped = true;
		}
	}

	recentLines(count: number): string[] {
		const text = Buffer.concat(this.chunks)
			.toString("utf8")
			.replace(/\r?\n$/, "");
		return text === "" ? [] : text.split(/\r?\n/).slice(-count);
	}

	drain(): Buffer[] {
		const drained = this.dropped ? [BACKLOG_DROPPED_MARKER, ...this.chunks] : this.chunks;
		this.chunks = [];
		this.bytes = 0;
		this.dropped = false;
		return drained;
	}
}

/**
 * Runs a command through Pi's built-in bash tool, so streaming, truncation, and error text match the
 * built-in. When the wait ends first, the still-running process is handed to the background runtime
 * instead of being killed.
 */
export async function runForeground(request: ForegroundRequest): Promise<AgentToolResult<unknown>> {
	const shell = resolveShellOptions(request.context.cwd, {}, request.context.isProjectTrusted?.() ?? false);
	const local = request.operations ?? createLocalBashOperations({ shellPath: shell.shellPath });
	const processAbort = new AbortController();
	const backlog = new Backlog();
	let sink: (data: Buffer) => void = () => {};
	let execution: Promise<{ exitCode: number | null }> | undefined;
	let detached = false;

	const operations: BashOperations = {
		exec: (command, cwd, options) => {
			sink = (data) => {
				backlog.push(data);
				options.onData(data);
			};
			const forwardAbort = () => processAbort.abort();
			if (options.signal?.aborted) forwardAbort();
			else options.signal?.addEventListener("abort", forwardAbort, { once: true });
			// The process outlives this call when it moves to the background, so it gets its own signal
			// and no built-in timeout.
			execution = local.exec(command, cwd, {
				onData: (data) => sink(data),
				signal: processAbort.signal,
				env: options.env,
			});
			const running = execution;
			return new Promise((resolve, reject) => {
				const timer =
					request.waitSeconds > 0
						? setTimeout(() => {
								// An interrupt that lands at the boundary wins: the run is being cancelled, not moved.
								if (options.signal?.aborted) return;
								detached = true;
								options.signal?.removeEventListener("abort", forwardAbort);
								// Output that arrives before the background job takes over must not be lost.
								sink = (data) => backlog.push(data);
								reject(new Error(DETACHED));
							}, Math.min(request.waitSeconds, MAX_TIMER_SECONDS) * 1000)
						: undefined;
				running.then(
					(result) => {
						if (timer) clearTimeout(timer);
						if (!detached) resolve(result);
					},
					(error) => {
						if (timer) clearTimeout(timer);
						if (!detached) reject(error);
					},
				);
			}).finally(() => {
				if (!detached) options.signal?.removeEventListener("abort", forwardAbort);
			}) as Promise<{ exitCode: number | null }>;
		},
	};

	const builtin = createBashToolDefinition(request.context.cwd, { operations, commandPrefix: shell.commandPrefix });
	try {
		const result = await builtin.execute(
			request.toolCallId,
			{ command: request.command },
			request.signal,
			request.onUpdate,
			request.context,
		);
		if (!result.isError) return result;
		return {
			...result,
			content: result.content.map((part) =>
				part.type === "text" ? { ...part, text: withFailureHints(part.text) } : part,
			),
		};
	} catch (error) {
		if (!detached || !execution) throw error;
	}

	const running = execution;
	const limitSeconds = request.backgroundTimeoutSeconds;
	const adoptExecution: ExecutionAdapter = ({ job, onData }) => {
		for (const chunk of backlog.drain()) onData(chunk);
		sink = onData;
		const onJobAbort = () => processAbort.abort();
		if (job.abortController.signal.aborted) onJobAbort();
		else job.abortController.signal.addEventListener("abort", onJobAbort, { once: true });
		let timedOut = false;
		const timer =
			limitSeconds > 0
				? setTimeout(() => {
						timedOut = true;
						processAbort.abort();
					}, Math.min(limitSeconds, MAX_TIMER_SECONDS) * 1000)
				: undefined;
		const timeoutError = () => new Error(`timeout:${limitSeconds}`);
		return running.then(
			(result) => {
				if (timer) clearTimeout(timer);
				if (timedOut) throw timeoutError();
				return result;
			},
			(error) => {
				if (timer) clearTimeout(timer);
				throw timedOut ? timeoutError() : error;
			},
		);
	};

	const recentLines = backlog.recentLines(RECENT_LINES);
	try {
		return await request.adopt({
			command: request.command,
			title: request.title,
			waitedSeconds: request.waitSeconds,
			recentLines,
			execute: adoptExecution,
			signal: request.signal,
		});
	} catch (error) {
		// Nothing owns the process once adoption fails, so it must not keep running unseen.
		processAbort.abort();
		running.catch(() => {});
		// The pre-move output only exists in this call, so the error has to carry it.
		const message = request.signal?.aborted
			? "Command aborted"
			: error instanceof Error
				? error.message
				: String(error);
		throw new Error(recentLines.length > 0 ? `${recentLines.join("\n")}\n\n${message}` : message);
	}
}
