/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight pi runtime fixtures and tool mocks. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enhancedBash from "../index.js";
import { collectReminderJobs } from "./running-reminder.js";
import { syncWindowMs } from "./runtime.js";

const directories: string[] = [];

async function makeContext() {
	const cwd = await mkdtemp(join(tmpdir(), "bash-async-index-"));
	directories.push(cwd);
	return {
		cwd,
		mode: "print",
		hasUI: false,
		model: undefined,
		sessionManager: { getSessionId: () => "index-test", getSessionFile: () => undefined },
	};
}

async function makeUiContext(ui: { setWidget: ReturnType<typeof vi.fn> }) {
	return { ...(await makeContext()), mode: "tui", hasUI: true, ui };
}

async function makeRpcContext(ui: { setWidget: ReturnType<typeof vi.fn> }) {
	return { ...(await makeContext()), mode: "rpc", hasUI: true, ui };
}

/** Registers the extension against a minimal host and returns the tools it registered. */
function register(host: Record<string, unknown> = {}): { bash: any; stop: any } {
	const tools: Record<string, any> = {};
	enhancedBash({
		on: vi.fn(),
		sendMessage: vi.fn(),
		...host,
		registerTool: (definition: any) => {
			tools[definition.name] = definition;
		},
	} as any);
	return { bash: tools.bash, stop: tools.bash_stop };
}

const widgetTheme = { fg: (_color: string, text: string) => text };

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("background bash lifecycle", () => {
	// These cases cover the background lifecycle, so starts must return before the command finishes.
	beforeEach(() => vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", "0"));

	it("registers bash and bash_stop and returns details for invalid and accepted calls", async () => {
		const on = vi.fn();
		const { bash, stop } = register({ on });
		expect(bash.parameters.properties.runInBackground).toBeDefined();
		expect(stop.parameters.properties.jobId).toBeDefined();
		expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));

		const context = await makeContext();
		const invalid = await stop.execute("invalid", {}, undefined, undefined, context);
		expect(invalid.details).toMatchObject({ error: expect.any(String) });
		const missing = await stop.execute("missing", { jobId: "nope" }, undefined, undefined, context);
		expect(missing.details).toMatchObject({ error: "job not found: nope" });
		const accepted = await bash.execute(
			"start",
			{ command: "sleep 30", timeout: 5, runInBackground: true },
			undefined,
			undefined,
			context,
		);
		expect(accepted.details).toMatchObject({ jobId: expect.any(String), status: expect.any(String) });
		expect(accepted.content[0].text).toContain("bash_stop");
		const stopped = await stop.execute("stop", { jobId: accepted.details.jobId }, undefined, undefined, context);
		expect(stopped.details).toMatchObject({ jobId: accepted.details.jobId, status: "killed" });
	});

	it("reports finished jobs once and never reports jobs bash_stop stopped", async () => {
		const handlers = new Map<string, (event?: unknown, context?: unknown) => unknown>();
		const sendMessage = vi.fn();
		const { bash, stop } = register({
			on: (event: string, handler: (event?: unknown, context?: unknown) => unknown) => handlers.set(event, handler),
			sendMessage,
		});
		const context = await makeContext();
		const start = (command: string) =>
			bash.execute("call", { command, timeout: 0, runInBackground: true }, undefined, undefined, context);
		const reportedIds = () => sendMessage.mock.calls.flatMap((call) => call[0].details.jobIds);

		try {
			const killed = await start("sleep 30");
			await stop.execute("stop", { jobId: killed.details.jobId }, undefined, undefined, context);

			// A job that already finished on its own keeps its completion; the stop result has no output.
			const finished = await start("printf finished");
			await vi.waitFor(() => expect(reportedIds()).toContain(finished.details.jobId), { timeout: 3_000 });
			await stop.execute("stop-late", { jobId: finished.details.jobId }, undefined, undefined, context);

			const failed = await start("printf output; exit 3");
			await vi.waitFor(() => expect(reportedIds()).toContain(failed.details.jobId), { timeout: 3_000 });

			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(reportedIds().sort()).toEqual([finished.details.jobId, failed.details.jobId].sort());
			for (const call of sendMessage.mock.calls) {
				expect(call[1]).toEqual({ triggerTurn: true, deliverAs: "steer" });
			}
		} finally {
			await (handlers.get("session_shutdown") as () => Promise<void>)?.();
		}
	}, 15_000);

	it("installs one below-editor widget for all running jobs and clears it after the final job", async () => {
		const ui = { setWidget: vi.fn() };
		const { bash, stop } = register();
		const context = await makeUiContext(ui);
		const start = (title: string) =>
			bash.execute(
				"call",
				{ command: "sleep 30", title, timeout: 0, runInBackground: true },
				undefined,
				undefined,
				context,
			);
		const first = await start("First job");
		const setCall = ui.setWidget.mock.calls[0];
		expect(setCall?.[0]).toBe("enhanced-bash-running-jobs");
		expect(setCall?.[2]).toEqual({ placement: "belowEditor" });
		const tui = { requestRender: vi.fn() };
		const widget = setCall?.[1](tui, widgetTheme);
		const second = await start("Second job");
		expect(tui.requestRender).toHaveBeenCalled();
		expect(widget.render(100)).toEqual([
			expect.stringMatching(/^bash & · First job · \d+s$/),
			expect.stringMatching(/^bash & · Second job · \d+s$/),
		]);

		await stop.execute("stop-first", { jobId: first.details.jobId }, undefined, undefined, context);
		expect(ui.setWidget).toHaveBeenCalledTimes(1);
		await stop.execute("stop-second", { jobId: second.details.jobId }, undefined, undefined, context);
		expect(ui.setWidget).toHaveBeenLastCalledWith("enhanced-bash-running-jobs", undefined);
	});

	it("does not install widget factories in RPC and clears a prior TUI widget before dropping its UI context", async () => {
		const tuiUi = { setWidget: vi.fn() };
		const rpcUi = { setWidget: vi.fn() };
		const { bash, stop } = register();
		const start = (title: string, context: unknown) =>
			bash.execute(
				"call",
				{ command: "sleep 30", title, timeout: 0, runInBackground: true },
				undefined,
				undefined,
				context,
			);
		const rpc = await makeRpcContext(rpcUi);
		const rpcJob = await start("RPC job", rpc);
		expect(rpcUi.setWidget).not.toHaveBeenCalled();
		await stop.execute("rpc-stop", { jobId: rpcJob.details.jobId }, undefined, undefined, rpc);

		const tui = await makeUiContext(tuiUi);
		const tuiJob = await start("TUI job", tui);
		expect(tuiUi.setWidget).toHaveBeenCalledWith("enhanced-bash-running-jobs", expect.any(Function), {
			placement: "belowEditor",
		});
		const rpcAgain = await start("Second RPC job", rpc);
		expect(tuiUi.setWidget).toHaveBeenLastCalledWith("enhanced-bash-running-jobs", undefined);
		expect(rpcUi.setWidget).not.toHaveBeenCalled();
		await stop.execute("tui-stop", { jobId: tuiJob.details.jobId }, undefined, undefined, rpc);
		await stop.execute("rpc-stop-2", { jobId: rpcAgain.details.jobId }, undefined, undefined, rpc);
	});

	it("never calls UI APIs for headless contexts and detaches UI callbacks during shutdown", async () => {
		let shutdown: (() => Promise<void>) | undefined;
		const ui = { setWidget: vi.fn() };
		const { bash } = register({
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_shutdown") shutdown = handler;
			},
		});
		const headless = { ...(await makeContext()), hasUI: false, ui };
		await bash.execute(
			"headless",
			{ command: "printf done", timeout: 5, runInBackground: true },
			undefined,
			undefined,
			headless,
		);
		await vi.waitFor(() => expect(ui.setWidget).not.toHaveBeenCalled());

		const interactive = await makeUiContext(ui);
		await bash.execute(
			"shutdown",
			{ command: "sleep 30", title: "Shutdown job", timeout: 0, runInBackground: true },
			undefined,
			undefined,
			interactive,
		);
		expect(ui.setWidget).toHaveBeenCalledTimes(1);
		await shutdown?.();
		expect(ui.setWidget).toHaveBeenLastCalledWith("enhanced-bash-running-jobs", undefined);
		const callsAfterShutdown = ui.setWidget.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ui.setWidget).toHaveBeenCalledTimes(callsAfterShutdown);
	});
});

describe("background bash start sync window", () => {
	async function setup() {
		const handlers = new Map<string, (event?: unknown, context?: unknown) => unknown>();
		const sendMessage = vi.fn();
		const { bash: tool } = register({
			on: (event: string, handler: (event?: unknown, context?: unknown) => unknown) => handlers.set(event, handler),
			sendMessage,
		});
		const context = await makeContext();
		const start = (command: string, signal?: AbortSignal) =>
			tool.execute("call", { runInBackground: true, command, timeout: 0 }, signal, undefined, context);
		const shutdown = () => (handlers.get("session_shutdown") as () => Promise<void>)?.();
		return { start, shutdown, sendMessage };
	}

	it("falls back to the default window for an unset or invalid value and clamps large ones", () => {
		const read = (value: string | undefined) => {
			vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", value as string);
			return syncWindowMs();
		};
		expect(read(undefined)).toBe(10_000);
		expect(read("  ")).toBe(10_000);
		expect(read("abc")).toBe(10_000);
		expect(read("-5")).toBe(10_000);
		expect(read("120000")).toBe(60_000);
		expect(read("1500")).toBe(1_500);
		expect(read("0")).toBe(0);
	});

	it("describes the sync window in effect, including when it is disabled", () => {
		const registerWith = (value: string) => {
			vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", value);
			return register().bash;
		};
		expect(registerWith("3000").description).toContain("waits up to 3s");
		expect(registerWith("0").description).not.toMatch(/waits up to/);
	});

	it("returns a command that finishes within the window inline and never reports it again", async () => {
		vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", "3000");
		const { start, shutdown, sendMessage } = await setup();
		try {
			const done = await start("printf 'one\\ntwo\\n'; exit 3");
			expect(done.content[0].text).toContain(`[${done.details.jobId}] failed (exit 3)`);
			expect(done.content[0].text).toContain("one\ntwo");
			// The inline result stands in for the follow-up, so it carries the runtime the follow-up would report.
			expect(done.content[0].text).toMatch(/failed \(exit 3\) in (\d+ms|\d+\.\ds)\n/);
			expect(done.details).toMatchObject({ status: "failed", exitCode: 3, runtimeMs: expect.any(Number) });

			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			await shutdown();
		}
	});

	it("keeps the final lines inline when the output exceeds the inline byte budget", async () => {
		vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", "10000");
		const { start, shutdown, sendMessage } = await setup();
		try {
			// ~65 bytes per line over 300 lines, well past both the inline byte budget and the line cap.
			const done = await start(`seq 1 300 | awk '{printf "%s %060d\\n", $0, $0}'`);
			const text = done.content[0].text as string;
			expect(done.details.status).toBe("succeeded");
			expect(text).toContain(`300 ${"0".repeat(57)}300`);
			const shown = text.match(/showing the last (\d+) of (\d+) lines/);
			expect(shown?.[2]).toBe("300");
			// The note has to match what the result actually carries, not the requested line count.
			const lines = text.split("\n").length - 3;
			expect(Number(shown?.[1])).toBe(lines);
			expect(lines).toBeLessThan(200);
			expect(text).toContain(done.details.logPath);

			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			await shutdown();
		}
	});

	it("leaves a command that outlives the window in the background and reports it as a follow-up", async () => {
		vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", "200");
		const { start, shutdown, sendMessage } = await setup();
		try {
			const started = await start("sleep 1; printf late");
			expect(started.details).toMatchObject({ jobId: expect.any(String), status: "running" });
			expect(started.content[0].text).toContain("still running after");

			await new Promise((resolve) => setTimeout(resolve, 1_800));
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage.mock.calls[0]?.[0].details.jobIds).toEqual([started.details.jobId]);
		} finally {
			await shutdown();
		}
	});

	it.each([0, 2])("steers when a background job exits with %s", async (exitCode) => {
		vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", "200");
		const { start, shutdown, sendMessage } = await setup();
		try {
			const started = await start(`sleep 1; exit ${exitCode}`);
			await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 3_000 });
			expect(sendMessage.mock.calls[0]?.[0].details.jobIds).toEqual([started.details.jobId]);
			expect(sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: true, deliverAs: "steer" });
		} finally {
			await shutdown();
		}
	});

	it.each([0, 2])("restores a dropped completion after exit %s", async (exitCode) => {
		vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", "0");
		const handlers = new Map<string, (event?: unknown, context?: unknown) => unknown>();
		const sendMessage = vi.fn();
		const { bash: tool } = register({
			on: (event: string, handler: (event?: unknown, context?: unknown) => unknown) => handlers.set(event, handler),
			sendMessage,
		});
		let idle = false;
		const context = { ...(await makeContext()), isIdle: () => idle };
		try {
			handlers.get("agent_start")?.({ type: "agent_start" }, context);
			const started = await tool.execute(
				"call",
				{ runInBackground: true, command: `exit ${exitCode}`, timeout: 0 },
				undefined,
				undefined,
				context,
			);
			await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 3_000 });
			expect(sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: true, deliverAs: "steer" });

			// Escape cleared Pi's queue: the run settles without a message_end for the completion.
			idle = true;
			handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
			expect(sendMessage).toHaveBeenCalledTimes(2);
			expect(sendMessage.mock.calls[1]?.[0].details.jobIds).toEqual([started.details.jobId]);
			expect(sendMessage.mock.calls[1]?.[1]).toEqual({ triggerTurn: false });
		} finally {
			await (handlers.get("session_shutdown") as () => Promise<void>)?.();
		}
	});

	it("kills the job when the tool call is interrupted during the window", async () => {
		vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", "10000");
		const { start, shutdown, sendMessage } = await setup();
		try {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 200);
			const begun = Date.now();
			const killed = await start("sleep 30", controller.signal);
			expect(Date.now() - begun).toBeLessThan(5_000);
			expect(killed.details).toMatchObject({ status: "killed" });

			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			await shutdown();
		}
	}, 10_000);
});

describe("background bash still-running reminder", () => {
	beforeEach(() => vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", "0"));

	async function setup() {
		const handlers = new Map<string, (event?: any, context?: any) => any>();
		const sendMessage = vi.fn();
		const { bash: tool } = register({
			on: (event: string, handler: (event?: any, context?: any) => any) => handlers.set(event, handler),
			sendMessage,
		});
		const context = await makeContext();
		const start = (command: string, title: string) =>
			tool.execute("call", { runInBackground: true, command, title, timeout: 0 }, undefined, undefined, context);
		const turnContext = (messages: unknown[], ctx: unknown = context) =>
			handlers.get("context")?.({ type: "context", messages }, ctx);
		const shutdown = () => handlers.get("session_shutdown")?.();
		return {
			start,
			turnContext,
			shutdown,
			sendMessage,
			context,
		};
	}

	const userTurn = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }];
	const assistantCall = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call", name: "background bash" }],
		timestamp: 2,
	};
	const toolResult = {
		role: "toolResult",
		toolCallId: "call",
		toolName: "background bash",
		content: [{ type: "text", text: "started" }],
		isError: false,
		timestamp: 3,
	};

	it("adds nothing when no job was started or every job has finished", async () => {
		const { start, turnContext, shutdown, sendMessage } = await setup();
		try {
			expect(turnContext(userTurn)).toBeUndefined();
			await start("printf done", "Quick print");
			await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 3_000 });
			expect(turnContext(userTurn)).toBeUndefined();
		} finally {
			await shutdown();
		}
	});

	it("names a running job on a request copy without touching the stored messages", async () => {
		const { start, turnContext, shutdown } = await setup();
		try {
			const started = await start("sleep 30", "Swift tests");
			const messages = [...userTurn];
			const result = turnContext(messages);
			expect(messages).toHaveLength(1);
			expect(result.messages).toHaveLength(2);
			const reminder = result.messages[1];
			expect(reminder).toMatchObject({ role: "custom", display: false });
			expect(reminder.content).toContain("Still running or awaiting delivery (results NOT delivered yet)");
			expect(reminder.content).toContain(`Background bash job ${started.details.jobId} "Swift tests"`);
			expect(reminder.content).toContain("until their completion notification arrives");
		} finally {
			await shutdown();
		}
	});

	it("lists only the still-running job on a turn started by another job's delivered completion", async () => {
		const { start, turnContext, shutdown, sendMessage } = await setup();
		try {
			const slow = await start("sleep 30", "Slow build");
			const fast = await start("printf done", "Fast check");
			await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 3_000 });
			const [delivered, options] = sendMessage.mock.calls[0] ?? [];
			expect(delivered.details.jobIds).toEqual([fast.details.jobId]);
			expect(options).toMatchObject({ triggerTurn: true });

			// Pi starts this turn from the delivered message itself, without a user prompt.
			const result = turnContext([...userTurn, { role: "custom", ...delivered, timestamp: 2 }]);
			const reminder = result.messages.at(-1).content as string;
			expect(reminder).toContain(`Background bash job ${slow.details.jobId} "Slow build"`);
			expect(reminder).not.toContain(fast.details.jobId);
			expect(reminder).not.toContain("Fast check");
		} finally {
			await shutdown();
		}
	});

	it("ignores jobs started by a different session", async () => {
		const { start, turnContext, shutdown, context } = await setup();
		try {
			await start("sleep 30", "Other session job");
			const otherSession = { ...context, sessionManager: { ...context.sessionManager, getSessionId: () => "other" } };
			expect(turnContext(userTurn, otherSession)).toBeUndefined();
		} finally {
			await shutdown();
		}
	});

	it("warns inside the tool loop that started the job and repeats the reminder verbatim", async () => {
		const { start, turnContext, shutdown } = await setup();
		try {
			// The turn opens with no job at all, which is exactly when a commit gets invented.
			expect(turnContext(userTurn)).toBeUndefined();
			const started = await start("sleep 30", "Swift tests");

			const afterStart = [...userTurn, assistantCall, toolResult];
			const first = turnContext(afterStart);
			expect(first.messages).toHaveLength(4);
			expect(first.messages.at(-1).content).toContain(`Background bash job ${started.details.jobId} "Swift tests"`);

			const nextCall = { ...assistantCall, timestamp: 4 };
			const nextResult = { ...toolResult, toolCallId: "call2", timestamp: 5 };
			const second = turnContext([...afterStart, nextCall, nextResult]);
			// Same text at the same place: the request only grows past the cached prefix.
			expect(second.messages.slice(0, 4)).toEqual(first.messages);
			expect(second.messages).toHaveLength(6);
		} finally {
			await shutdown();
		}
	});

	it("adds a fresh reminder when a new turn starts and keeps the earlier one in place", async () => {
		const { start, turnContext, shutdown } = await setup();
		try {
			await start("sleep 30", "Swift tests");
			const first = turnContext(userTurn);
			const second = turnContext([
				...userTurn,
				{ role: "user", content: [{ type: "text", text: "news?" }], timestamp: 9 },
			]);
			expect(second.messages.slice(0, 2)).toEqual(first.messages);
			expect(second.messages).toHaveLength(4);
			expect(second.messages.at(-1).content).toContain('"Swift tests"');
		} finally {
			await shutdown();
		}
	});
});

describe("background bash reminder job collection", () => {
	const job = (id: string, status: string) => ({ id, title: id, status, queuedAt: 0, startedAt: 0 }) as any;

	it("keeps a terminal job the manager already evicted while the batcher still owes its completion", () => {
		const listed = [job("a", "running"), job("b", "succeeded")];
		const collected = collectReminderJobs(listed, [job("b", "succeeded"), job("c", "failed")]);
		expect(collected.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
	});

	it("drops terminal jobs whose completion already went out", () => {
		expect(collectReminderJobs([job("a", "running"), job("b", "succeeded")], [])).toHaveLength(1);
	});
});
