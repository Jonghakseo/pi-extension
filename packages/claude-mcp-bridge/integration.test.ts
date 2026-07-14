import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import claudeMcpBridge from "./index.ts";

type RegisteredTool = {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((result: unknown) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

const originalEnv = {
	PI_MCP_CONFIG: process.env.PI_MCP_CONFIG,
	PI_MCP_CACHE_PATH: process.env.PI_MCP_CACHE_PATH,
	PI_MCP_EAGER: process.env.PI_MCP_EAGER,
	PI_OFFLINE: process.env.PI_OFFLINE,
};
let tempDir: string | null = null;
let sessionStartHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
let shutdownHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];

function restoreEnv(name: keyof typeof originalEnv): void {
	const value = originalEnv[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(async () => {
	const ctx = { hasUI: false, ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
	for (const handler of shutdownHandlers) await handler({}, ctx);
	sessionStartHandlers = [];
	shutdownHandlers = [];
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	tempDir = null;
	restoreEnv("PI_MCP_CONFIG");
	restoreEnv("PI_MCP_CACHE_PATH");
	restoreEnv("PI_MCP_EAGER");
	restoreEnv("PI_OFFLINE");
});

describe("lazy MCP stdio integration", () => {
	it("shows the runtime before a delayed server is ready and calls its tool after discovery", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-integration-"));
		const fixturePath = fileURLToPath(new URL("./test-fixtures/delayed-stdio-server.mjs", import.meta.url));
		const configPath = path.join(tempDir, "mcp.json");
		process.env.PI_MCP_CONFIG = configPath;
		process.env.PI_MCP_CACHE_PATH = path.join(tempDir, "cache", "tools-v1.json");
		delete process.env.PI_MCP_EAGER;
		delete process.env.PI_OFFLINE;
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: {
					Delayed: {
						command: process.execPath,
						args: [fixturePath],
						env: { MOCK_MCP_DELAY_MS: "3000" },
					},
				},
			}),
			"utf-8",
		);

		const tools = new Map<string, RegisteredTool>();
		const activeTools = new Set<string>(["read"]);
		const api = {
			registerTool(tool: RegisteredTool & { name: string }) {
				const isNew = !tools.has(tool.name);
				tools.set(tool.name, tool);
				if (isNew) activeTools.add(tool.name);
			},
			registerCommand() {},
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
				if (name === "session_start") sessionStartHandlers.push(handler);
				if (name === "session_shutdown") shutdownHandlers.push(handler);
			},
			getActiveTools() {
				return Array.from(activeTools);
			},
			setActiveTools(names: string[]) {
				activeTools.clear();
				for (const name of names) activeTools.add(name);
			},
		} as unknown as ExtensionAPI;

		const factoryStartedAt = performance.now();
		await claudeMcpBridge(api);
		const factoryElapsedMs = performance.now() - factoryStartedAt;
		expect(factoryElapsedMs).toBeLessThan(1_500);
		expect(tools.size).toBe(0);

		const toolReadyStartedAt = performance.now();
		const sessionContext = {
			cwd: process.cwd(),
			hasUI: true,
			ui: { notify: vi.fn(), setStatus: vi.fn() },
		} as unknown as ExtensionContext;
		for (const handler of sessionStartHandlers) await handler({}, sessionContext);
		await vi.waitFor(() => expect(tools.has("mcp__delayed__echo")).toBe(true), { timeout: 5_000, interval: 50 });
		const toolReadyElapsedMs = performance.now() - toolReadyStartedAt;
		expect(toolReadyElapsedMs).toBeGreaterThanOrEqual(2_500);
		expect(toolReadyElapsedMs).toBeLessThan(5_000);

		const echo = tools.get("mcp__delayed__echo");
		expect(echo).toBeDefined();
		const result = await echo?.execute("call", { message: "hello" }, undefined, undefined, {
			hasUI: false,
		} as ExtensionContext);
		expect(result?.content[0]?.text).toBe("pong:hello");
	}, 10_000);
});
