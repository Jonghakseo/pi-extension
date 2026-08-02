import fs from "node:fs";
import { createServer, type Server as NodeHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Server as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport as LegacySSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport as LegacyStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler, fromJsonSchema, type McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import claudeMcpBridge, { McpConnection, normalizeServer } from "./index.ts";

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
let httpServer: NodeHttpServer | null = null;
let mcpHttpHandler: McpHttpHandler | null = null;
let sessionStartHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
let shutdownHandlers: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];

function restoreEnv(name: keyof typeof originalEnv): void {
	const value = originalEnv[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

afterEach(async () => {
	const ctx = { hasUI: false, ui: { notify: vi.fn(), setStatus: vi.fn() } } as unknown as ExtensionContext;
	for (const handler of shutdownHandlers) await handler({}, ctx);
	sessionStartHandlers = [];
	shutdownHandlers = [];
	if (httpServer) {
		await new Promise<void>((resolve, reject) => {
			httpServer?.close((error) => (error ? reject(error) : resolve()));
		});
		httpServer = null;
	}
	await mcpHttpHandler?.close();
	mcpHttpHandler = null;
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	tempDir = null;
	restoreEnv("PI_MCP_CONFIG");
	restoreEnv("PI_MCP_CACHE_PATH");
	restoreEnv("PI_MCP_EAGER");
	restoreEnv("PI_OFFLINE");
});

describe("dual-era MCP integration", () => {
	it("shows the runtime before a delayed legacy server is ready and calls its tool after fallback", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-integration-"));
		const fixturePath = fileURLToPath(new URL("./test-fixtures/legacy-stdio-server.mjs", import.meta.url));
		const configPath = path.join(tempDir, "mcp.json");
		process.env.PI_MCP_CONFIG = configPath;
		process.env.PI_MCP_CACHE_PATH = path.join(tempDir, "cache", "tools-v1.json");
		delete process.env.PI_MCP_EAGER;
		delete process.env.PI_OFFLINE;
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: {
					Legacy: {
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
			isProjectTrusted: () => true,
			ui: { notify: vi.fn(), setStatus: vi.fn() },
		} as unknown as ExtensionContext;
		for (const handler of sessionStartHandlers) await handler({}, sessionContext);
		await vi.waitFor(() => expect(tools.has("mcp__legacy__echo")).toBe(true), { timeout: 10_000, interval: 50 });
		const toolReadyElapsedMs = performance.now() - toolReadyStartedAt;
		expect(toolReadyElapsedMs).toBeGreaterThanOrEqual(5_500);
		expect(toolReadyElapsedMs).toBeLessThan(10_000);

		const echo = tools.get("mcp__legacy__echo");
		expect(echo).toBeDefined();
		const result = await echo?.execute("call", { message: "hello" }, undefined, undefined, {
			hasUI: false,
		} as ExtensionContext);
		expect(result?.content[0]?.text).toBe("legacy:hello");
	}, 15_000);

	it("negotiates the modern protocol with an actual serveStdio server", async () => {
		const fixturePath = fileURLToPath(new URL("./test-fixtures/modern-stdio-server.mjs", import.meta.url));
		const server = normalizeServer("ModernStdio", { command: process.execPath, args: [fixturePath] });
		if (!server) throw new Error("Failed to normalize modern stdio fixture");
		const connection = new McpConnection(server);

		try {
			await connection.connect({ timeoutMs: 10_000 });
			expect(connection.status).toBe("connected");
			expect(connection.tools.map((tool) => tool.name)).toContain("echo");
			const result = await connection.callTool("echo", { message: "hello" });
			expect(result).toMatchObject({ content: [{ type: "text", text: "modern:hello" }] });
		} finally {
			await connection.dispose();
		}
	}, 15_000);

	it("reaps the actual stdio probe process when disposed during negotiation", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-probe-dispose-"));
		const pidPath = path.join(tempDir, "probe-pids.txt");
		const fixturePath = fileURLToPath(new URL("./test-fixtures/modern-stdio-server.mjs", import.meta.url));
		const server = normalizeServer("SlowModernStdio", {
			command: process.execPath,
			args: [fixturePath],
			env: { MOCK_MCP_DELAY_MS: "10000", MOCK_MCP_PID_PATH: pidPath },
		});
		if (!server) throw new Error("Failed to normalize delayed modern stdio fixture");
		const connection = new McpConnection(server);
		const connecting = connection.connect({ timeoutMs: 30_000 }).catch((error: unknown) => error);

		await vi.waitFor(() => expect(fs.existsSync(pidPath)).toBe(true), { timeout: 5_000, interval: 25 });
		const pids = fs.readFileSync(pidPath, "utf-8").trim().split("\n").filter(Boolean).map(Number);
		expect(pids.length).toBeGreaterThan(0);
		expect(pids.some(isProcessAlive)).toBe(true);

		await connection.dispose();
		await expect(connecting).resolves.toBeInstanceOf(Error);
		await vi.waitFor(() => expect(pids.every((pid) => !isProcessAlive(pid))).toBe(true), {
			timeout: 5_000,
			interval: 25,
		});
	}, 10_000);

	it("connects to an actual legacy HTTP+SSE server", async () => {
		const sessions = new Map<string, { transport: LegacySSEServerTransport; server: LegacyMcpServer }>();
		httpServer = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (req.method === "GET" && url.pathname === "/sse") {
				const transport = new LegacySSEServerTransport("/messages", res);
				const server = new LegacyMcpServer(
					{ name: "legacy-sse-test-server", version: "1.0.0" },
					{ capabilities: { tools: {} } },
				);
				server.setRequestHandler(ListToolsRequestSchema, async () => ({
					tools: [
						{
							name: "echo",
							description: "Echo from a legacy SSE server",
							inputSchema: {
								type: "object",
								properties: { message: { type: "string" } },
								required: ["message"],
							},
						},
					],
				}));
				server.setRequestHandler(CallToolRequestSchema, async (request) => ({
					content: [{ type: "text", text: `legacy-sse:${String(request.params.arguments?.message ?? "")}` }],
				}));
				sessions.set(transport.sessionId, { transport, server });
				transport.onclose = () => {
					sessions.delete(transport.sessionId);
				};
				void server.connect(transport).catch((error: unknown) => {
					res.destroy(error instanceof Error ? error : new Error(String(error)));
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/messages") {
				const session = sessions.get(url.searchParams.get("sessionId") ?? "");
				if (!session) {
					res.writeHead(404).end("Session not found");
					return;
				}
				void session.transport.handlePostMessage(req, res).catch((error: unknown) => {
					res.destroy(error instanceof Error ? error : new Error(String(error)));
				});
				return;
			}
			res.writeHead(404).end();
		});
		await new Promise<void>((resolve, reject) => {
			httpServer?.once("error", reject);
			httpServer?.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("Legacy SSE server did not bind");
		const normalized = normalizeServer("LegacySse", {
			type: "sse",
			url: `http://127.0.0.1:${address.port}/sse`,
		});
		if (!normalized) throw new Error("Failed to normalize legacy SSE fixture");
		const connection = new McpConnection(normalized);

		try {
			await connection.connect({ timeoutMs: 10_000 });
			const result = await connection.callTool("echo", { message: "hello" });
			expect(result).toMatchObject({ content: [{ type: "text", text: "legacy-sse:hello" }] });
		} finally {
			await connection.dispose();
		}
	}, 15_000);

	it("falls back to the legacy protocol with an actual v1 Streamable HTTP server", async () => {
		const requestMethods: Array<string | undefined> = [];
		httpServer = createServer((req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405).end();
				return;
			}
			requestMethods.push(req.headers["mcp-method"] as string | undefined);
			const server = new LegacyMcpServer(
				{ name: "legacy-http-test-server", version: "1.0.0" },
				{ capabilities: { tools: {} } },
			);
			server.setRequestHandler(ListToolsRequestSchema, async () => ({
				tools: [
					{
						name: "echo",
						description: "Echo from a legacy HTTP server",
						inputSchema: {
							type: "object",
							properties: { message: { type: "string" } },
							required: ["message"],
						},
					},
				],
			}));
			server.setRequestHandler(CallToolRequestSchema, async (request) => ({
				content: [{ type: "text", text: `legacy-http:${String(request.params.arguments?.message ?? "")}` }],
			}));
			const transport = new LegacyStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			res.once("close", () => {
				void transport.close();
				void server.close();
			});
			void (async () => {
				await server.connect(transport);
				await transport.handleRequest(req, res);
			})().catch((error: unknown) => {
				res.destroy(error instanceof Error ? error : new Error(String(error)));
			});
		});
		await new Promise<void>((resolve, reject) => {
			httpServer?.once("error", reject);
			httpServer?.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("Legacy HTTP server did not bind");
		const normalized = normalizeServer("LegacyHttp", {
			type: "http",
			url: `http://127.0.0.1:${address.port}/mcp`,
		});
		if (!normalized) throw new Error("Failed to normalize legacy HTTP fixture");
		const connection = new McpConnection(normalized);

		try {
			await connection.connect({ timeoutMs: 10_000 });
			const result = await connection.callTool("echo", { message: "hello" });
			expect(result).toMatchObject({ content: [{ type: "text", text: "legacy-http:hello" }] });
			expect(requestMethods[0]).toBe("server/discover");
			expect(requestMethods.slice(1).every((method) => method === undefined)).toBe(true);
		} finally {
			await connection.dispose();
		}
	}, 15_000);

	it("negotiates the stateless 2026 protocol over HTTP while preserving tool discovery and calls", async () => {
		const requests: Array<{
			method?: string;
			name?: string;
			protocolVersion?: string;
			sessionId?: string;
		}> = [];
		mcpHttpHandler = createMcpHandler(({ era }) => {
			const server = new McpServer({ name: "stateless-integration-server", version: "1.0.0" });
			server.registerTool(
				"echo",
				{
					description: "Echo through the negotiated protocol era",
					inputSchema: fromJsonSchema({
						type: "object",
						properties: { message: { type: "string" } },
						required: ["message"],
					}),
				},
				async (args) => {
					const message = typeof args === "object" && args !== null && "message" in args ? String(args.message) : "";
					return { content: [{ type: "text" as const, text: `${era}:${message}` }] };
				},
			);
			return server;
		});
		const nodeHandler = toNodeHandler(mcpHttpHandler);
		httpServer = createServer((req, res) => {
			if (req.method === "POST") {
				requests.push({
					method: req.headers["mcp-method"] as string | undefined,
					name: req.headers["mcp-name"] as string | undefined,
					protocolVersion: req.headers["mcp-protocol-version"] as string | undefined,
					sessionId: req.headers["mcp-session-id"] as string | undefined,
				});
			}
			void nodeHandler(req, res).catch((error: unknown) => {
				res.destroy(error instanceof Error ? error : new Error(String(error)));
			});
		});
		await new Promise<void>((resolve, reject) => {
			httpServer?.once("error", reject);
			httpServer?.listen(0, "127.0.0.1", () => resolve());
		});
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("HTTP test server did not bind to a TCP port");

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-modern-integration-"));
		const configPath = path.join(tempDir, "mcp.json");
		process.env.PI_MCP_CONFIG = configPath;
		process.env.PI_MCP_CACHE_PATH = path.join(tempDir, "cache", "tools-v1.json");
		delete process.env.PI_MCP_EAGER;
		delete process.env.PI_OFFLINE;
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				mcpServers: {
					Stateless: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` },
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

		await claudeMcpBridge(api);
		const sessionContext = {
			cwd: process.cwd(),
			hasUI: true,
			isProjectTrusted: () => true,
			ui: { notify: vi.fn(), setStatus: vi.fn() },
		} as unknown as ExtensionContext;
		for (const handler of sessionStartHandlers) await handler({}, sessionContext);
		await vi.waitFor(() => expect(tools.has("mcp__stateless__echo")).toBe(true), { timeout: 5_000, interval: 25 });

		const echo = tools.get("mcp__stateless__echo");
		const result = await echo?.execute("call", { message: "hello" }, undefined, undefined, {
			hasUI: false,
		} as ExtensionContext);
		expect(result?.content[0]?.text).toBe("modern:hello");
		expect(requests.map((request) => request.method)).toEqual(
			expect.arrayContaining(["server/discover", "tools/list", "tools/call"]),
		);
		expect(requests.every((request) => request.protocolVersion === "2026-07-28")).toBe(true);
		expect(requests.every((request) => request.sessionId === undefined)).toBe(true);
		expect(requests.find((request) => request.method === "tools/call")?.name).toBe("echo");
	}, 10_000);
});
