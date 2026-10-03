/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight pi runtime fixtures and tool mocks. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bashAsync, { syncWindowMs } from "./index.js";
import { TOOL_NAME } from "./tool-schema.js";

const directories: string[] = [];

async function makeContext() {
	const cwd = await mkdtemp(join(tmpdir(), "bash-async-index-"));
	directories.push(cwd);
	return {
		cwd,
		mode: "print",
		hasUI: false,
		isIdle: () => true,
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

const widgetTheme = { fg: (_color: string, text: string) => text };

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bash_async extension registration", () => {
	// These cases cover the background lifecycle, so starts must return before the command finishes.
	beforeEach(() => vi.stubEnv("PI_BASH_ASYNC_SYNC_WINDOW_MS", "0"));

	it("registers bash_async with guidance and returns details for invalid and accepted calls", async () => {
		let tool: any;
		const on = vi.fn();
		bashAsync({ registerTool: (definition: any) => (tool = definition), on, sendMessage: vi.fn() } as any);
		expect(tool.name).toBe(TOOL_NAME);
		expect(tool.parameters.properties.action).toBeDefined();
		expect(tool.promptGuidelines.join(" ")).toContain("bash_async");
		expect(on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));

		const context = await makeContext();
		const invalid = await tool.execute("invalid", { action: "start" }, undefined, undefined, context);
		expect(invalid.details).toMatchObject({ error: expect.any(String) });
		const accepted = await tool.execute(
			"start",
			{ action: "start", command: "printf done", timeout: 5 },
			undefined,
			undefined,
			context,
		);
		expect(accepted.details).toMatchObject({ jobId: expect.any(String), status: expect.any(String) });

		const theme = { fg: (_color: string, text: string) => text };
		expect(tool.renderResult(accepted, { expanded: false }, theme).render(100)).toEqual([]);
		expect(tool.renderResult(accepted, { expanded: true }, theme).render(100).join("\n")).toContain(
			"Do not call sleep",
		);
		expect(tool.renderResult(invalid, { expanded: false }, theme).render(100).join("\n")).toContain("bash_async:");
	});

	it("does not re-report jobs that were killed or whose terminal result was already read", async () => {
		let tool: any;
		const handlers = new Map<string, (event?: unknown, context?: unknown) => unknown>();
		const sendMessage = vi.fn();
		let idle = false;
		vi.stubEnv("PI_BASH_ASYNC_POLL_COOLDOWN_MS", "0");
		bashAsync({
			registerTool: (definition: any) => (tool = definition),
			on: (event: string, handler: (event?: unknown, context?: unknown) => unknown) => handlers.set(event, handler),
			sendMessage,
		} as any);
		const context = { ...(await makeContext()), isIdle: () => idle };
		const run = (action: Record<string, unknown>) => tool.execute("call", action, undefined, undefined, context);
		const waitTerminal = (jobId: string) =>
			vi.waitFor(async () => {
				const listed = await run({ action: "list" });
				expect(listed.details.jobs.find((entry: any) => entry.id === jobId)?.status).toBe("succeeded");
			});

		try {
			const killed = await run({ action: "start", command: "sleep 30", timeout: 0 });
			await run({ action: "kill", jobId: killed.details.jobId });

			const statusRead = await run({ action: "start", command: "printf status", timeout: 0 });
			await waitTerminal(statusRead.details.jobId);
			await run({ action: "status", jobId: statusRead.details.jobId });

			const outputRead = await run({ action: "start", command: "printf output; exit 3", timeout: 0 });
			await vi.waitFor(async () => {
				const output = await run({ action: "output", jobId: outputRead.details.jobId });
				// The terminal read stands in for the follow-up, so it must carry the final status.
				expect(output.content[0].text).toContain(`[${outputRead.details.jobId}] failed (exit 3)`);
			});

			const unread = await run({ action: "start", command: "printf unread", timeout: 0 });
			await waitTerminal(unread.details.jobId);

			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(sendMessage).not.toHaveBeenCalled();
			handlers.get("turn_end")?.({ type: "turn_end", toolResults: [{}], message: {} }, context);
			expect(sendMessage).not.toHaveBeenCalled();
			handlers.get("turn_end")?.({ type: "turn_end", toolResults: [], message: {} }, context);
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage.mock.calls[0]?.[0].details.jobIds).toEqual([unread.details.jobId]);
			expect(sendMessage.mock.calls[0]?.[1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });

			idle = true;
			handlers.get("agent_end")?.({ type: "agent_end" }, context);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(sendMessage).toHaveBeenCalledTimes(1);
		} finally {
			await (handlers.get("session_shutdown") as () => Promise<void>)?.();
		}
	});

	it("delivers a completion that finishes during compaction without waiting for another turn", async () => {
		let tool: any;
		const handlers = new Map<string, (event?: unknown, context?: unknown) => unknown>();
		const sendMessage = vi.fn();
		bashAsync({
			registerTool: (definition: any) => (tool = definition),
			on: (event: string, handler: (event?: unknown, context?: unknown) => unknown) => handlers.set(event, handler),
			sendMessage,
		} as any);
		// Pi reports compaction as not idle.
		const context = { ...(await makeContext()), isIdle: () => false };
		try {
			handlers.get("session_before_compact")?.({ type: "session_before_compact" }, context);
			const started = await tool.execute(
				"call",
				{ action: "start", command: "printf done", timeout: 0 },
				undefined,
				undefined,
				context,
			);
			await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 3_000 });
			expect(sendMessage.mock.calls[0]?.[0].details.jobIds).toEqual([started.details.jobId]);
		} finally {
			await (handlers.get("session_shutdown") as () => Promise<void>)?.();
		}
	});

	it("returns details for status, output, list, incremental output, and kill", async () => {
		let tool: any;
		let shutdown: (() => Promise<void>) | undefined;
		vi.stubEnv("PI_BASH_ASYNC_POLL_COOLDOWN_MS", "0");
		bashAsync({
			registerTool: (definition: any) => (tool = definition),
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_shutdown") shutdown = handler;
			},
			sendMessage: vi.fn(),
		} as any);
		const context = await makeContext();
		const started = await tool.execute(
			"start-actions",
			{ action: "start", command: "printf 'one\\ntwo\\n'; sleep 30", timeout: 0 },
			undefined,
			undefined,
			context,
		);
		const jobId = started.details.jobId as string;

		const status = await tool.execute("status", { action: "status", jobId }, undefined, undefined, context);
		expect(status.details).toMatchObject({ jobId, status: expect.stringMatching(/queued|running/) });
		await vi.waitFor(async () => {
			const output = await tool.execute("output-ready", { action: "output", jobId }, undefined, undefined, context);
			expect(output.content[0]?.text).toContain("one");
		});
		const firstOutput = await tool.execute(
			"output-first",
			{ action: "output", jobId, incremental: true },
			undefined,
			undefined,
			context,
		);
		expect(firstOutput.details).toMatchObject({ jobId, startOffset: 0, nextOffset: 2 });
		const secondOutput = await tool.execute(
			"output-second",
			{ action: "output", jobId, incremental: true },
			undefined,
			undefined,
			context,
		);
		expect(secondOutput.details).toMatchObject({ jobId, startOffset: 2, nextOffset: 2 });
		const listed = await tool.execute("list", { action: "list" }, undefined, undefined, context);
		expect(listed.details.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: jobId })]));
		const killed = await tool.execute("kill", { action: "kill", jobId }, undefined, undefined, context);
		expect(killed.details).toMatchObject({ jobId, status: "killed" });
		await shutdown?.();
	});

	it("rate limits repeated status, output, and list queries that carry no new information", async () => {
		let tool: any;
		vi.stubEnv("PI_BASH_ASYNC_POLL_COOLDOWN_MS", "60000");
		bashAsync({ registerTool: (definition: any) => (tool = definition), on: vi.fn(), sendMessage: vi.fn() } as any);
		const context = await makeContext();
		const started = await tool.execute(
			"poll-start",
			{ action: "start", command: "printf 'one\\ntwo\\nthree\\n'; sleep 30", timeout: 0 },
			undefined,
			undefined,
			context,
		);
		const jobId = started.details.jobId as string;
		await vi.waitFor(async () => {
			const running = await tool.execute("poll-running", { action: "status", jobId }, undefined, undefined, context);
			expect(running.details.status).toBe("running");
		});

		const blockedStatus = await tool.execute("poll-status", { action: "status", jobId }, undefined, undefined, context);
		expect(blockedStatus.details.error).toContain("Do not poll");
		await vi.waitFor(async () => {
			const ready = await tool.execute(
				"poll-output",
				{ action: "output", jobId, outputOffset: 0 },
				undefined,
				undefined,
				context,
			);
			expect(ready.details).toMatchObject({ startOffset: 0, nextOffset: 3 });
		});
		const pagedOutput = await tool.execute(
			"poll-output-paged",
			{ action: "output", jobId, outputOffset: 0, lines: 1 },
			undefined,
			undefined,
			context,
		);
		expect(pagedOutput.details).toMatchObject({ startOffset: 0, nextOffset: 1 });
		const repeatedRange = await tool.execute(
			"poll-output-repeat",
			{ action: "output", jobId, outputOffset: 0 },
			undefined,
			undefined,
			context,
		);
		expect(repeatedRange.details.error).toContain("Do not poll");
		const freshRange = await tool.execute(
			"poll-output-incremental",
			{ action: "output", jobId, incremental: true },
			undefined,
			undefined,
			context,
		);
		expect(freshRange.details).toMatchObject({ startOffset: 0, nextOffset: 3 });
		await tool.execute("poll-list", { action: "list" }, undefined, undefined, context);
		const blockedList = await tool.execute("poll-list-2", { action: "list" }, undefined, undefined, context);
		expect(blockedList.details.error).toContain("Do not poll");

		const killed = await tool.execute("poll-kill", { action: "kill", jobId }, undefined, undefined, context);
		expect(killed.details).toMatchObject({ jobId, status: "killed" });
		const terminalStatus = await tool.execute(
			"poll-status-terminal",
			{ action: "status", jobId },
			undefined,
			undefined,
			context,
		);
		expect(terminalStatus.details).toMatchObject({ jobId, status: "killed" });
	});

	it("installs one below-editor widget for all running jobs and clears it after the final job", async () => {
		let tool: any;
		const ui = { setWidget: vi.fn() };
		bashAsync({ registerTool: (definition: any) => (tool = definition), on: vi.fn(), sendMessage: vi.fn() } as any);
		const context = await makeUiContext(ui);
		const first = await tool.execute(
			"widget-first",
			{ action: "start", command: "sleep 30", title: "First job", timeout: 0 },
			undefined,
			undefined,
			context,
		);
		const setCall = ui.setWidget.mock.calls[0];
		expect(setCall?.[0]).toBe("bash-async-running-jobs");
		expect(setCall?.[2]).toEqual({ placement: "belowEditor" });
		const tui = { requestRender: vi.fn() };
		const widget = setCall?.[1](tui, widgetTheme);
		const second = await tool.execute(
			"widget-second",
			{ action: "start", command: "sleep 30", title: "Second job", timeout: 0 },
			undefined,
			undefined,
			context,
		);
		expect(tui.requestRender).toHaveBeenCalled();
		expect(widget.render(100)).toEqual([
			expect.stringMatching(/^bash_async · First job · \d+s$/),
			expect.stringMatching(/^bash_async · Second job · \d+s$/),
		]);

		await tool.execute(
			"widget-kill-first",
			{ action: "kill", jobId: first.details.jobId },
			undefined,
			undefined,
			context,
		);
		expect(ui.setWidget).toHaveBeenCalledTimes(1);
		await tool.execute(
			"widget-kill-second",
			{ action: "kill", jobId: second.details.jobId },
			undefined,
			undefined,
			context,
		);
		expect(ui.setWidget).toHaveBeenLastCalledWith("bash-async-running-jobs", undefined);
	});

	it("does not install widget factories in RPC and clears a prior TUI widget before dropping its UI context", async () => {
		let tool: any;
		const tuiUi = { setWidget: vi.fn() };
		const rpcUi = { setWidget: vi.fn() };
		bashAsync({ registerTool: (definition: any) => (tool = definition), on: vi.fn(), sendMessage: vi.fn() } as any);
		const rpc = await makeRpcContext(rpcUi);
		const rpcJob = await tool.execute(
			"rpc",
			{ action: "start", command: "sleep 30", title: "RPC job", timeout: 0 },
			undefined,
			undefined,
			rpc,
		);
		expect(rpcUi.setWidget).not.toHaveBeenCalled();
		await tool.execute("rpc-kill", { action: "kill", jobId: rpcJob.details.jobId }, undefined, undefined, rpc);

		const tui = await makeUiContext(tuiUi);
		const tuiJob = await tool.execute(
			"tui",
			{ action: "start", command: "sleep 30", title: "TUI job", timeout: 0 },
			undefined,
			undefined,
			tui,
		);
		expect(tuiUi.setWidget).toHaveBeenCalledWith("bash-async-running-jobs", expect.any(Function), {
			placement: "belowEditor",
		});
		await tool.execute("rpc-list", { action: "list" }, undefined, undefined, rpc);
		expect(tuiUi.setWidget).toHaveBeenLastCalledWith("bash-async-running-jobs", undefined);
		expect(rpcUi.setWidget).not.toHaveBeenCalled();
		await tool.execute("tui-kill", { action: "kill", jobId: tuiJob.details.jobId }, undefined, undefined, rpc);
	});

	it("never calls UI APIs for headless contexts and detaches UI callbacks during shutdown", async () => {
		let tool: any;
		let shutdown: (() => Promise<void>) | undefined;
		const ui = { setWidget: vi.fn() };
		bashAsync({
			registerTool: (definition: any) => (tool = definition),
			on: (event: string, handler: () => Promise<void>) => {
				if (event === "session_shutdown") shutdown = handler;
			},
			sendMessage: vi.fn(),
		} as any);
		const headless = { ...(await makeContext()), hasUI: false, ui };
		await tool.execute(
			"headless",
			{ action: "start", command: "printf done", timeout: 5 },
			undefined,
			undefined,
			headless,
		);
		await vi.waitFor(() => expect(ui.setWidget).not.toHaveBeenCalled());

		const interactive = await makeUiContext(ui);
		await tool.execute(
			"shutdown",
			{ action: "start", command: "sleep 30", title: "Shutdown job", timeout: 0 },
			undefined,
			undefined,
			interactive,
		);
		expect(ui.setWidget).toHaveBeenCalledTimes(1);
		await shutdown?.();
		expect(ui.setWidget).toHaveBeenLastCalledWith("bash-async-running-jobs", undefined);
		const callsAfterShutdown = ui.setWidget.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ui.setWidget).toHaveBeenCalledTimes(callsAfterShutdown);
	});
});

describe("bash_async start sync window", () => {
	async function setup() {
		let tool: any;
		const handlers = new Map<string, (event?: unknown, context?: unknown) => unknown>();
		const sendMessage = vi.fn();
		bashAsync({
			registerTool: (definition: any) => (tool = definition),
			on: (event: string, handler: (event?: unknown, context?: unknown) => unknown) => handlers.set(event, handler),
			sendMessage,
		} as any);
		// A tool call runs while the agent is busy, which is when completions are held.
		const context = { ...(await makeContext()), isIdle: () => false };
		const start = (command: string, signal?: AbortSignal) =>
			tool.execute("call", { action: "start", command, timeout: 0 }, signal, undefined, context);
		const flushTurn = () => handlers.get("turn_end")?.({ type: "turn_end", toolResults: [], message: {} }, context);
		const shutdown = () => (handlers.get("session_shutdown") as () => Promise<void>)?.();
		return { start, flushTurn, shutdown, sendMessage };
	}

	it("falls back to the default window for an unset or invalid value and clamps large ones", () => {
		const read = (value: string | undefined) => {
			vi.stubEnv("PI_BASH_ASYNC_SYNC_WINDOW_MS", value as string);
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
			vi.stubEnv("PI_BASH_ASYNC_SYNC_WINDOW_MS", value);
			let tool: any;
			bashAsync({ registerTool: (definition: any) => (tool = definition), on: vi.fn(), sendMessage: vi.fn() } as any);
			return tool;
		};
		const waiting = registerWith("3000");
		expect([waiting.description, ...waiting.promptGuidelines].join(" ")).toContain("waits up to 3s");
		// With a window in effect the tool is no longer reserved for long jobs, and the snippet must not say so.
		expect(waiting.promptSnippet).not.toContain("long");
		const disabled = registerWith("0");
		expect([disabled.description, ...disabled.promptGuidelines].join(" ")).not.toMatch(/waits up to|within \d/);
		expect(disabled.promptSnippet).toContain("long");
	});

	it("returns a command that finishes within the window inline and never reports it again", async () => {
		vi.stubEnv("PI_BASH_ASYNC_SYNC_WINDOW_MS", "3000");
		const { start, flushTurn, shutdown, sendMessage } = await setup();
		try {
			const done = await start("printf 'one\\ntwo\\n'; exit 3");
			expect(done.content[0].text).toContain(`[${done.details.jobId}] failed (exit 3)`);
			expect(done.content[0].text).toContain("one\ntwo");
			// The inline result stands in for the follow-up, so it carries the runtime the follow-up would report.
			expect(done.content[0].text).toMatch(/failed \(exit 3\) in (\d+ms|\d+\.\ds)\n/);
			expect(done.details).toMatchObject({ status: "failed", exitCode: 3, runtimeMs: expect.any(Number) });

			await new Promise((resolve) => setTimeout(resolve, 600));
			flushTurn();
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			await shutdown();
		}
	});

	it("keeps the final lines inline when the output exceeds the inline byte budget", async () => {
		vi.stubEnv("PI_BASH_ASYNC_SYNC_WINDOW_MS", "10000");
		const { start, flushTurn, shutdown, sendMessage } = await setup();
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
			flushTurn();
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			await shutdown();
		}
	});

	it("leaves a command that outlives the window in the background and reports it as a follow-up", async () => {
		vi.stubEnv("PI_BASH_ASYNC_SYNC_WINDOW_MS", "200");
		const { start, flushTurn, shutdown, sendMessage } = await setup();
		try {
			const started = await start("sleep 1; printf late");
			expect(started.details).toMatchObject({ jobId: expect.any(String), status: "running" });
			expect(started.content[0].text).toContain("still running after");

			await new Promise((resolve) => setTimeout(resolve, 1_800));
			flushTurn();
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(sendMessage.mock.calls[0]?.[0].details.jobIds).toEqual([started.details.jobId]);
		} finally {
			await shutdown();
		}
	});

	it("does not spend the window on a job queued behind the concurrency limit", async () => {
		vi.stubEnv("PI_BASH_ASYNC_SYNC_WINDOW_MS", "200");
		vi.stubEnv("PI_BASH_ASYNC_MAX_CONCURRENCY", "1");
		const { start, shutdown } = await setup();
		try {
			await start("sleep 30");
			const begun = Date.now();
			const queued = await start("printf queued");
			expect(Date.now() - begun).toBeLessThan(150);
			expect(queued.details).toMatchObject({ status: "queued" });
		} finally {
			await shutdown();
		}
	});

	it("kills the job when the tool call is interrupted during the window", async () => {
		vi.stubEnv("PI_BASH_ASYNC_SYNC_WINDOW_MS", "10000");
		const { start, flushTurn, shutdown, sendMessage } = await setup();
		try {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 200);
			const begun = Date.now();
			const killed = await start("sleep 30", controller.signal);
			expect(Date.now() - begun).toBeLessThan(5_000);
			expect(killed.details).toMatchObject({ status: "killed" });

			await new Promise((resolve) => setTimeout(resolve, 600));
			flushTurn();
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			await shutdown();
		}
	}, 10_000);
});
