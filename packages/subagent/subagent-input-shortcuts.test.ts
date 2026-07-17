/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store.ts";
import type { SingleResult } from "./types.ts";

const mockDiscoverAgents = vi.hoisted(() => vi.fn());
const mockEnqueueSubagentInvocation = vi.hoisted(() => vi.fn());
const mockRunSingleAgent = vi.hoisted(() => vi.fn());
const mockUpdateCommandRunsWidget = vi.hoisted(() => vi.fn());

vi.mock("./agents.js", () => ({
	discoverAgents: (...args: unknown[]) => mockDiscoverAgents(...args),
}));

vi.mock("./invocation-queue.js", () => ({
	enqueueSubagentInvocation: (...args: unknown[]) => mockEnqueueSubagentInvocation(...args),
}));

vi.mock("./widget.js", () => ({
	updateCommandRunsWidget: (...args: unknown[]) => mockUpdateCommandRunsWidget(...args),
}));

vi.mock("./runner.js", async () => {
	const actual = await vi.importActual<typeof import("./runner.js")>("./runner.js");
	return {
		...actual,
		runSingleAgent: (...args: unknown[]) => mockRunSingleAgent(...args),
	};
});

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] } as never],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		...overrides,
	};
}

function createPi() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	return {
		commands,
		handlers,
		pi: {
			registerTool: vi.fn(),
			registerCommand: vi.fn((name: string, command: any) => {
				commands.set(name, command);
			}),
			registerShortcut: vi.fn(),
			on: vi.fn((event: string, handler: any) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			}),
			sendMessage: vi.fn(),
		},
	};
}

async function dispatchInput(handlers: Map<string, any[]>, text: string, ctx: any) {
	let currentText = text;
	for (const handler of handlers.get("input") ?? []) {
		const result = await handler({ source: "user", text: currentText }, ctx);
		if (result?.action === "handled") return result;
		if (result?.action === "transform") currentText = result.text;
	}
	return currentText === text ? { action: "continue" as const } : { action: "transform" as const, text: currentText };
}

describe("subagent input shortcuts", () => {
	let tmpDir: string;

	beforeEach(() => {
		mockDiscoverAgents.mockReset();
		mockEnqueueSubagentInvocation.mockReset();
		mockRunSingleAgent.mockReset();
		mockUpdateCommandRunsWidget.mockReset();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-input-shortcuts-"));
		fs.mkdirSync(path.join(tmpDir, ".pi"));
		fs.writeFileSync(path.join(tmpDir, ".pi", "subagent.json"), JSON.stringify({ symbolMap: { "?": "searcher" } }));
		mockDiscoverAgents.mockReturnValue({
			agents: [
				{ name: "worker", source: "user", systemPrompt: "", runtime: "pi" },
				{ name: "searcher", source: "user", systemPrompt: "", runtime: "pi" },
			],
			projectAgentsDir: null,
		});
		mockEnqueueSubagentInvocation.mockImplementation(async (fn: () => Promise<unknown>) => await fn());
		mockRunSingleAgent.mockImplementation(async (...args: unknown[]) => {
			const agent = String(args[2]);
			const task = String(args[3]);
			return makeResult({ agent, task });
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it(">? routes to hidden searcher", async () => {
		const { registerAll } = await import("./commands.ts");
		const store = createStore();
		const { pi, handlers } = createPi();
		registerAll(pi as never, store);

		const ctx = {
			cwd: tmpDir,
			hasUI: true,
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				getEditorText: vi.fn(() => ""),
				setEditorText: vi.fn(),
			},
			sessionManager: {
				getSessionFile: () => path.join(tmpDir, "main.jsonl"),
				getEntries: () => [],
			},
		};

		const result = await dispatchInput(handlers, ">? search this", ctx);
		await Promise.resolve();
		await Promise.resolve();

		expect(result.action).toBe("handled");
		expect(mockRunSingleAgent).toHaveBeenCalled();
		expect(mockRunSingleAgent.mock.calls[0]?.[2]).toBe("searcher");
		expect(String(mockRunSingleAgent.mock.calls[0]?.[3])).toContain("search this");
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does not route symbols when symbolMap is empty", async () => {
		fs.writeFileSync(path.join(tmpDir, ".pi", "subagent.json"), JSON.stringify({ symbolMap: {} }));
		const { registerAll } = await import("./commands.ts");
		const store = createStore();
		const { pi, handlers } = createPi();
		registerAll(pi as never, store);
		const ctx = {
			cwd: tmpDir,
			hasUI: true,
			ui: { notify: vi.fn(), select: vi.fn(), getEditorText: vi.fn(() => ""), setEditorText: vi.fn() },
			sessionManager: { getSessionFile: () => path.join(tmpDir, "main.jsonl"), getEntries: () => [] },
		};
		const result = await dispatchInput(handlers, ">>? search this", ctx);
		expect(result.action).toBe("continue");
		expect(mockRunSingleAgent).not.toHaveBeenCalled();
	});

	it("leaves ordinary Markdown blockquotes and removed legacy prefixes for the main agent", async () => {
		const { registerAll } = await import("./commands.ts");
		const store = createStore();
		const { pi, handlers } = createPi();
		registerAll(pi as never, store);
		const ctx = {
			cwd: tmpDir,
			hasUI: true,
			ui: { notify: vi.fn(), select: vi.fn(), getEditorText: vi.fn(() => ""), setEditorText: vi.fn() },
			sessionManager: { getSessionFile: () => path.join(tmpDir, "main.jsonl"), getEntries: () => [] },
		};

		const single = await dispatchInput(handlers, ">quoted context", ctx);
		const legacy = await dispatchInput(handlers, ">>> worker do hidden work", ctx);
		const legacySymbol = await dispatchInput(handlers, ">>>? search this", ctx);

		expect(single.action).toBe("continue");
		expect(legacy.action).toBe("continue");
		expect(legacySymbol.action).toBe("continue");
		expect(mockRunSingleAgent).not.toHaveBeenCalled();
	});

	it("transforms >agent mentions before symbol shortcuts without launching a run", async () => {
		fs.writeFileSync(path.join(tmpDir, ".pi", "subagent.json"), JSON.stringify({ symbolMap: { w: "searcher" } }));
		const { registerAll } = await import("./commands.ts");
		const store = createStore();
		const { pi, handlers } = createPi();
		registerAll(pi as never, store);
		const ctx = {
			cwd: tmpDir,
			hasUI: true,
			ui: { notify: vi.fn(), select: vi.fn(), getEditorText: vi.fn(() => ""), setEditorText: vi.fn() },
			sessionManager: { getSessionFile: () => path.join(tmpDir, "main.jsonl"), getEntries: () => [] },
		};

		const result = await dispatchInput(handlers, "please implement this >worker", ctx);
		const leadingResult = await dispatchInput(handlers, ">worker implement this", ctx);

		expect(result).toEqual({ action: "transform", text: "please implement this subagent:worker" });
		expect(leadingResult).toEqual({ action: "transform", text: "subagent:worker implement this" });
		expect(mockRunSingleAgent).not.toHaveBeenCalled();
	});

	it("> task defaults to hidden worker", async () => {
		const { registerAll } = await import("./commands.ts");
		const store = createStore();
		const { pi, handlers } = createPi();
		registerAll(pi as never, store);

		const ctx = {
			cwd: tmpDir,
			hasUI: true,
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				getEditorText: vi.fn(() => ""),
				setEditorText: vi.fn(),
			},
			sessionManager: {
				getSessionFile: () => path.join(tmpDir, "main.jsonl"),
				getEntries: () => [],
			},
		};

		const result = await dispatchInput(handlers, "> do hidden work", ctx);
		await Promise.resolve();
		await Promise.resolve();

		expect(result.action).toBe("handled");
		expect(mockRunSingleAgent).toHaveBeenCalled();
		expect(mockRunSingleAgent.mock.calls[0]?.[2]).toBe("worker");
		expect(String(mockRunSingleAgent.mock.calls[0]?.[3])).toContain("do hidden work");
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("uses a configured defaultAgent", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi", "subagent.json"),
			JSON.stringify({ defaultAgent: "searcher", symbolMap: {} }),
		);
		const { registerAll } = await import("./commands.ts");
		const store = createStore();
		const { pi, handlers } = createPi();
		registerAll(pi as never, store);
		const ctx = {
			cwd: tmpDir,
			hasUI: true,
			ui: { notify: vi.fn(), select: vi.fn(), getEditorText: vi.fn(() => ""), setEditorText: vi.fn() },
			sessionManager: { getSessionFile: () => path.join(tmpDir, "main.jsonl"), getEntries: () => [] },
		};

		await dispatchInput(handlers, "> custom default work", ctx);
		await Promise.resolve();
		await Promise.resolve();

		expect(mockRunSingleAgent.mock.calls[0]?.[2]).toBe("searcher");
	});

	it("rejects a missing configured defaultAgent before launch", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi", "subagent.json"),
			JSON.stringify({ defaultAgent: "missing", symbolMap: {} }),
		);
		const { registerAll } = await import("./commands.ts");
		const store = createStore();
		const { pi, handlers } = createPi();
		registerAll(pi as never, store);
		const ctx = {
			cwd: tmpDir,
			hasUI: true,
			ui: { notify: vi.fn(), select: vi.fn(), getEditorText: vi.fn(() => ""), setEditorText: vi.fn() },
			sessionManager: { getSessionFile: () => path.join(tmpDir, "main.jsonl"), getEntries: () => [] },
		};

		await dispatchInput(handlers, "> implement the task", ctx);

		expect(mockRunSingleAgent).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('Configured defaultAgent "missing" was not found. Available agents: searcher, worker'),
			"error",
		);
	});

	it('does not register plain ">" as a keyboard shortcut', async () => {
		const { registerAll } = await import("./commands.ts");
		const store = createStore();
		const { pi } = createPi();
		registerAll(pi as never, store);

		const shortcuts = pi.registerShortcut.mock.calls.map(([shortcut]) => shortcut);
		expect(shortcuts).not.toContain(">");
		expect(shortcuts).not.toContain(">>>");
	});
});
