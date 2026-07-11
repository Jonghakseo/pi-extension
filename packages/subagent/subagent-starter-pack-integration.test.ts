/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAll } from "./commands.ts";
import { createStore } from "./store.ts";

function createPi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	return {
		tools,
		commands,
		pi: {
			registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
			registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
			registerShortcut: vi.fn(),
			on: vi.fn(),
			sendMessage: vi.fn(),
		},
	};
}

describe("starter pack list entrypoints", () => {
	let tmpDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-starter-entrypoint-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function makeCtx() {
		return {
			cwd: tmpDir,
			hasUI: true,
			ui: {
				confirm: vi.fn().mockResolvedValue(true),
				notify: vi.fn(),
				setWidget: vi.fn(),
			},
			sessionManager: {
				getSessionFile: () => path.join(tmpDir, "main.jsonl"),
				getEntries: () => [],
			},
		};
	}

	it("offers the starter pack from the list-agents tool", async () => {
		const { pi, tools } = createPi();
		registerAll(pi as never, createStore());
		const ctx = makeCtx();

		const result = await tools.get("list-agents").execute("call", {}, undefined, undefined, ctx);

		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toContain("worker");
		expect(result.content[0].text).toContain("Starter pack installed");
	});

	it("offers the starter pack from the subagent agents tool command", async () => {
		const { pi, tools } = createPi();
		registerAll(pi as never, createStore());
		const ctx = makeCtx();

		const result = await tools
			.get("subagent")
			.execute("call", { command: "subagent agents" }, undefined, undefined, ctx);

		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toContain("worker");
		expect(result.content[0].text).toContain("Starter pack installed");
	});

	it("returns interactive installation guidance from a headless tool call", async () => {
		const { pi, tools } = createPi();
		registerAll(pi as never, createStore());
		const ctx = makeCtx();
		ctx.hasUI = false;

		const result = await tools
			.get("subagent")
			.execute("call", { command: "subagent agents" }, undefined, undefined, ctx);

		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("Run /subagents in an interactive Pi session");
		expect(fs.existsSync(path.join(tmpDir, "agents"))).toBe(false);
	});

	it("offers the starter pack from /subagents", async () => {
		const { pi, commands } = createPi();
		registerAll(pi as never, createStore());
		const ctx = makeCtx();

		await commands.get("subagents").handler("", ctx);

		expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Starter pack installed"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("worker"), "info");
	});
});
