/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight pi runtime fixtures and tool mocks. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import bashAsync from "./index.js";
import { TOOL_NAME } from "./tool-schema.js";

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

const widgetTheme = { fg: (_color: string, text: string) => text };

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bash_async extension registration", () => {
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
	});

	it("returns details for status, output, list, incremental output, and kill", async () => {
		let tool: any;
		let shutdown: (() => Promise<void>) | undefined;
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
