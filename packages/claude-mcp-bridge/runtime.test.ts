import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

type MockTool = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
};

type ClientPlan = {
	connect: Deferred<void>;
	ignoreAbort?: boolean;
	tools: MockTool[];
	callResult?: unknown;
	callError?: Error;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const sdkMock = vi.hoisted(() => ({
	plans: [] as ClientPlan[],
	transports: [] as string[],
	clients: [] as Array<{
		plan: ClientPlan;
		connectOptions?: { signal?: AbortSignal; timeout?: number };
		listToolsOptions?: { signal?: AbortSignal; timeout?: number };
		callToolOptions?: { signal?: AbortSignal; timeout?: number };
		transportKind?: string;
		triggerClose: () => void;
		callToolCalls: number;
		closeCalls: number;
	}>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class MockClient {
		onclose?: () => void;
		onerror?: (error: Error) => void;
		private readonly record: (typeof sdkMock.clients)[number];

		constructor() {
			const plan = sdkMock.plans.shift();
			if (!plan) throw new Error("Missing MCP client plan");
			this.record = { plan, closeCalls: 0, callToolCalls: 0, triggerClose: () => this.onclose?.() };
			sdkMock.clients.push(this.record);
		}

		connect(transport: { kind?: string }, options?: { signal?: AbortSignal; timeout?: number }): Promise<void> {
			this.record.connectOptions = options;
			this.record.transportKind = transport.kind;
			const promise = this.record.plan.connect.promise;
			if (!options?.signal || this.record.plan.ignoreAbort) return promise;
			if (options.signal.aborted) return Promise.reject(options.signal.reason);
			return new Promise<void>((resolve, reject) => {
				const onAbort = () => reject(options.signal?.reason ?? new Error("Cancelled"));
				options.signal?.addEventListener("abort", onAbort, { once: true });
				promise.then(
					() => {
						options.signal?.removeEventListener("abort", onAbort);
						resolve();
					},
					(error) => {
						options.signal?.removeEventListener("abort", onAbort);
						reject(error);
					},
				);
			});
		}

		async listTools(_params?: unknown, options?: { signal?: AbortSignal; timeout?: number }) {
			this.record.listToolsOptions = options;
			return { tools: this.record.plan.tools };
		}

		async callTool(_params: unknown, _schema?: unknown, options?: { signal?: AbortSignal; timeout?: number }) {
			this.record.callToolCalls++;
			this.record.callToolOptions = options;
			if (this.record.plan.callError) throw this.record.plan.callError;
			return this.record.plan.callResult ?? { content: [{ type: "text", text: "ok" }] };
		}

		async close() {
			this.record.closeCalls++;
		}
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: class {
		kind = "stdio";
		constructor() {
			sdkMock.transports.push(this.kind);
		}
		async close(): Promise<void> {}
	},
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: class {
		kind = "sse";
		constructor() {
			sdkMock.transports.push(this.kind);
		}
		async close(): Promise<void> {}
	},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		kind = "http";
		constructor() {
			sdkMock.transports.push(this.kind);
		}
		async close(): Promise<void> {}
	},
}));

import claudeMcpBridge, {
	buildConfigFingerprint,
	McpConnection,
	type McpToolCache,
	normalizeServer,
	saveMcpToolCache,
	startBackgroundConnect,
} from "./index.ts";

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((result: unknown) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;
};

type RegisteredCommand = {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
};

type MockPi = {
	api: ExtensionAPI;
	tools: Map<string, RegisteredTool>;
	commands: Map<string, RegisteredCommand>;
	activeTools: Set<string>;
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	statuses: string[];
};

function createMockPi(): MockPi {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const activeTools = new Set<string>(["read"]);
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const statuses: string[] = [];
	const api = {
		registerTool(tool: RegisteredTool) {
			const isNew = !tools.has(tool.name);
			tools.set(tool.name, tool);
			if (isNew) activeTools.add(tool.name);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getActiveTools() {
			return Array.from(activeTools);
		},
		setActiveTools(names: string[]) {
			activeTools.clear();
			for (const name of names) activeTools.add(name);
		},
	} as unknown as ExtensionAPI;
	return { api, tools, commands, activeTools, handlers, statuses };
}

function createContext(statuses: string[]): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			setStatus(_key: string, text: string | undefined) {
				if (text) statuses.push(text);
			},
			notify: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

function createPlan(tools: MockTool[] = [], options: { pending?: boolean; ignoreAbort?: boolean } = {}): ClientPlan {
	const connect = deferred<void>();
	if (!options.pending) connect.resolve(undefined);
	return { connect, tools, ignoreAbort: options.ignoreAbort };
}

function tool(name: string): MockTool {
	return {
		name,
		description: `${name} description`,
		inputSchema: { type: "object", properties: { query: { type: "string" } } },
	};
}

const tempDirs: string[] = [];
const runtimes: MockPi[] = [];
const originalEnv = new Map<string, string | undefined>();
const envKeys = [
	"PI_MCP_CONFIG",
	"PI_MCP_CACHE_PATH",
	"PI_MCP_EAGER",
	"PI_OFFLINE",
	"PI_MCP_CONNECT_TIMEOUT_MS",
	"PI_MCP_TOOL_TIMEOUT_MS",
];

function writeConfig(servers: Record<string, unknown>): { configPath: string; cachePath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-runtime-test-"));
	tempDirs.push(dir);
	const configPath = path.join(dir, "mcp.json");
	const cachePath = path.join(dir, "cache", "tools-v1.json");
	fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }), "utf-8");
	process.env.PI_MCP_CONFIG = configPath;
	process.env.PI_MCP_CACHE_PATH = cachePath;
	return { configPath, cachePath };
}

function writeCache(cachePath: string, serverName: string, tools: MockTool[]): void {
	const server = normalizeServer(serverName, { command: "mock-mcp" });
	if (!server) throw new Error("Failed to normalize test server");
	const cache: McpToolCache = {
		version: 1,
		configFingerprint: buildConfigFingerprint([server]),
		servers: {
			[serverName]: { updatedAt: "2026-07-14T00:00:00.000Z", tools },
		},
	};
	saveMcpToolCache(cache, cachePath);
}

async function startSession(pi: MockPi): Promise<void> {
	const ctx = createContext(pi.statuses);
	for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, ctx);
}

async function shutdown(pi: MockPi): Promise<void> {
	const ctx = createContext(pi.statuses);
	for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
}

beforeEach(() => {
	for (const key of envKeys) {
		originalEnv.set(key, process.env[key]);
		delete process.env[key];
	}
	sdkMock.plans.length = 0;
	sdkMock.transports.length = 0;
	sdkMock.clients.length = 0;
});

afterEach(async () => {
	for (const runtime of runtimes.splice(0).reverse()) await shutdown(runtime);
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const key of envKeys) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	originalEnv.clear();
});

describe("lazy MCP runtime", () => {
	it("returns from the factory without waiting and deduplicates the background promise", async () => {
		writeConfig({ Lazy: { command: "mock-mcp" } });
		const plan = createPlan([tool("search")], { pending: true });
		sdkMock.plans.push(plan);
		const pi = createMockPi();
		runtimes.push(pi);

		await claudeMcpBridge(pi.api);
		expect(pi.tools.size).toBe(0);
		expect(sdkMock.clients).toHaveLength(0);
		const first = startBackgroundConnect(process.cwd());
		const second = startBackgroundConnect(process.cwd());
		expect(first).toBe(second);

		plan.connect.resolve(undefined);
		await first;
		expect(pi.tools.has("mcp__lazy__search")).toBe(true);
		expect(pi.activeTools.has("mcp__lazy__search")).toBe(true);
	});

	it("keeps the eager escape hatch waiting for discovery", async () => {
		writeConfig({ Eager: { command: "mock-mcp" } });
		process.env.PI_MCP_EAGER = "1";
		const plan = createPlan([tool("ready")], { pending: true });
		sdkMock.plans.push(plan);
		const pi = createMockPi();
		runtimes.push(pi);

		let settled = false;
		const loadPromise = claudeMcpBridge(pi.api).then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(sdkMock.clients).toHaveLength(1));
		expect(settled).toBe(false);

		plan.connect.resolve(undefined);
		await loadPromise;
		expect(pi.tools.has("mcp__eager__ready")).toBe(true);
	});

	it("registers healthy server tools when another server fails", async () => {
		writeConfig({ Broken: { command: "broken" }, Healthy: { command: "healthy" } });
		const broken = createPlan([], { pending: true });
		broken.connect.reject(new Error("connection refused"));
		const healthy = createPlan([tool("lookup")]);
		sdkMock.plans.push(broken, healthy);
		const pi = createMockPi();
		runtimes.push(pi);

		await claudeMcpBridge(pi.api);
		await startBackgroundConnect(process.cwd());
		await startSession(pi);

		expect(pi.tools.has("mcp__healthy__lookup")).toBe(true);
		expect(pi.tools.has("mcp__broken__lookup")).toBe(false);
		expect(pi.statuses.at(-1)).toBe("MCP 1/2 · 1 failed");
	});

	it("keeps SSE and streamable HTTP transport discovery working", async () => {
		writeConfig({
			Events: { type: "sse", url: "https://events.example.com/sse" },
			Remote: { type: "http", url: "https://remote.example.com/mcp" },
		});
		sdkMock.plans.push(createPlan([tool("events")]), createPlan([tool("remote")]));
		const pi = createMockPi();
		runtimes.push(pi);

		await claudeMcpBridge(pi.api);
		await startBackgroundConnect(process.cwd());

		expect(sdkMock.clients.map((client) => client.transportKind)).toEqual(["sse", "http"]);
		expect(pi.tools.has("mcp__events__events")).toBe(true);
		expect(pi.tools.has("mcp__remote__remote")).toBe(true);
	});

	it("reconnects after an unexpected transport close", async () => {
		writeConfig({ Reconnect: { command: "mock-mcp" } });
		sdkMock.plans.push(createPlan([tool("first")]));
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);
		await startBackgroundConnect(process.cwd());

		sdkMock.plans.push(createPlan([tool("second")]));
		vi.useFakeTimers();
		try {
			sdkMock.clients[0]?.triggerClose();
			await vi.advanceTimersByTimeAsync(2_000);
			expect(sdkMock.clients).toHaveLength(2);
			expect(pi.tools.has("mcp__reconnect__second")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("recovers automatically after an initial connection failure", async () => {
		writeConfig({ Retry: { command: "mock-mcp" } });
		const failed = createPlan([], { pending: true });
		failed.connect.reject(new Error("server starting"));
		sdkMock.plans.push(failed, createPlan([tool("recovered")]));
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		vi.useFakeTimers();
		try {
			await startBackgroundConnect(process.cwd());
			expect(pi.tools.has("mcp__retry__recovered")).toBe(false);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(sdkMock.clients).toHaveLength(2);
			expect(pi.tools.has("mcp__retry__recovered")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("moves invalid server URLs to error instead of leaving them connecting", async () => {
		writeConfig({ Invalid: { type: "http", url: "not a valid URL" } });
		sdkMock.plans.push(createPlan());
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		await startBackgroundConnect(process.cwd());
		await startSession(pi);

		expect(pi.statuses.at(-1)).toBe("MCP 0/1 · 1 failed");
		expect(sdkMock.clients).toHaveLength(1);
		expect(sdkMock.transports).toHaveLength(0);
	});

	it("uses cached tools offline without starting a connection", async () => {
		const { cachePath } = writeConfig({ Offline: { command: "mock-mcp" } });
		writeCache(cachePath, "Offline", [tool("cached_search")]);
		process.env.PI_OFFLINE = "1";
		const pi = createMockPi();
		runtimes.push(pi);

		await claudeMcpBridge(pi.api);
		await startSession(pi);

		expect(sdkMock.clients).toHaveLength(0);
		expect(pi.tools.has("mcp__offline__cached_search")).toBe(true);
		expect(pi.statuses.at(-1)).toBe("MCP offline · cached");
		await expect(
			pi.tools.get("mcp__offline__cached_search")?.execute("call", {}, undefined, undefined, createContext([])),
		).rejects.toThrow("offline mode is enabled");
	});

	it("waits for the existing connection before calling a cached tool and forwards cancellation", async () => {
		const { cachePath } = writeConfig({ Cached: { command: "mock-mcp" } });
		writeCache(cachePath, "Cached", [tool("search")]);
		const plan = createPlan([tool("search")], { pending: true });
		plan.callResult = { content: [{ type: "text", text: "result" }] };
		sdkMock.plans.push(plan);
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		const updates: unknown[] = [];
		const controller = new AbortController();
		const resultPromise = pi.tools
			.get("mcp__cached__search")
			?.execute("call", { query: "x" }, controller.signal, (update) => updates.push(update), createContext([]));
		expect(resultPromise).toBeDefined();
		expect(updates).toEqual([
			expect.objectContaining({
				content: [{ type: "text", text: "Connecting to MCP server 'Cached'..." }],
			}),
		]);

		plan.connect.resolve(undefined);
		await expect(resultPromise).resolves.toMatchObject({ content: [{ type: "text", text: "result" }] });
		expect(sdkMock.clients[0]?.callToolOptions?.signal).toBe(controller.signal);
	});

	it("does not call a cached tool removed during live discovery", async () => {
		const { cachePath } = writeConfig({ Removed: { command: "mock-mcp" } });
		writeCache(cachePath, "Removed", [tool("search")]);
		const plan = createPlan([], { pending: true });
		sdkMock.plans.push(plan);
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		const registered = pi.tools.get("mcp__removed__search");
		if (!registered) throw new Error("cached tool was not registered");
		const resultPromise = registered.execute("call", {}, undefined, undefined, createContext([]));
		plan.connect.resolve(undefined);

		await expect(resultPromise).rejects.toThrow("is no longer advertised by the server");
		expect(sdkMock.clients[0]?.callToolCalls).toBe(0);
	});

	it("does not send cached arguments after the live input schema changes", async () => {
		const { cachePath } = writeConfig({ Changed: { command: "mock-mcp" } });
		writeCache(cachePath, "Changed", [tool("search")]);
		const changedTool = {
			...tool("search"),
			inputSchema: {
				type: "object",
				properties: { issueId: { type: "number" } },
				required: ["issueId"],
			},
		};
		const plan = createPlan([changedTool], { pending: true });
		sdkMock.plans.push(plan);
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		const registered = pi.tools.get("mcp__changed__search");
		if (!registered) throw new Error("cached tool was not registered");
		const resultPromise = registered.execute("call", { query: "old" }, undefined, undefined, createContext([]));
		plan.connect.resolve(undefined);

		await expect(resultPromise).rejects.toThrow("changed schema while connecting; retry the call");
		expect(sdkMock.clients[0]?.callToolCalls).toBe(0);
	});

	it("isolates a cancelled waiter from another call sharing the same connection", async () => {
		const { cachePath } = writeConfig({ Shared: { command: "mock-mcp" } });
		writeCache(cachePath, "Shared", [tool("search")]);
		const plan = createPlan([tool("search")], { pending: true });
		sdkMock.plans.push(plan);
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		const registered = pi.tools.get("mcp__shared__search");
		if (!registered) throw new Error("cached tool was not registered");
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = registered.execute("first", {}, firstController.signal, undefined, createContext([]));
		const second = registered.execute("second", {}, secondController.signal, undefined, createContext([]));
		firstController.abort(new Error("stop first waiter"));

		await expect(first).rejects.toThrow("connection was cancelled");
		plan.connect.resolve(undefined);
		await expect(second).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
		expect(sdkMock.clients[0]?.connectOptions?.signal).not.toBe(firstController.signal);
		expect(sdkMock.clients[0]?.connectOptions?.signal).not.toBe(secondController.signal);
		expect(sdkMock.clients[0]?.callToolOptions?.signal).toBe(secondController.signal);
	});

	it("bounds transport startup with the configured wall-clock timeout", async () => {
		writeConfig({ Hanging: { command: "mock-mcp" } });
		process.env.PI_MCP_CONNECT_TIMEOUT_MS = "20";
		const plan = createPlan([], { pending: true, ignoreAbort: true });
		sdkMock.plans.push(plan);
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		const startedAt = performance.now();
		await startBackgroundConnect(process.cwd());
		const elapsedMs = performance.now() - startedAt;
		await startSession(pi);

		expect(elapsedMs).toBeLessThan(500);
		expect(sdkMock.clients[0]?.connectOptions?.timeout).toBe(20);
		expect(pi.statuses.at(-1)).toBe("MCP 0/1 · 1 failed");
	});

	it("returns a clear timeout error when a cached tool cannot connect", async () => {
		const { cachePath } = writeConfig({ Timeout: { command: "mock-mcp" } });
		writeCache(cachePath, "Timeout", [tool("search")]);
		const plan = createPlan([tool("search")], { pending: true });
		sdkMock.plans.push(plan);
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		const resultPromise = pi.tools
			.get("mcp__timeout__search")
			?.execute("call", {}, undefined, undefined, createContext([]));
		plan.connect.reject(new Error("Request timed out"));
		await expect(resultPromise).rejects.toThrow("MCP server 'Timeout' is unavailable: connection timed out");
	});

	it("preserves a user-inactive tool when live discovery replaces its schema", async () => {
		const { cachePath } = writeConfig({ Visibility: { command: "mock-mcp" } });
		writeCache(cachePath, "Visibility", [tool("search")]);
		const liveTool = { ...tool("search"), description: "updated live description" };
		sdkMock.plans.push(createPlan([liveTool]));
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);
		pi.activeTools.delete("mcp__visibility__search");

		await startBackgroundConnect(process.cwd());
		expect(pi.tools.get("mcp__visibility__search")).toBeDefined();
		expect(pi.activeTools.has("mcp__visibility__search")).toBe(false);
	});

	it("reactivates a bridge-deactivated tool when it reappears with the same schema", async () => {
		const { cachePath } = writeConfig({ Dynamic: { command: "mock-mcp" } });
		writeCache(cachePath, "Dynamic", [tool("search")]);
		sdkMock.plans.push(createPlan([]), createPlan([tool("search")]));
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		await startBackgroundConnect(process.cwd());
		expect(pi.activeTools.has("mcp__dynamic__search")).toBe(false);

		const responses: unknown[] = ["Dynamic", "reconnect", null];
		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => responses.shift(),
				notify: vi.fn(),
				setStatus: vi.fn(),
			},
			reload: vi.fn(),
		} as unknown as ExtensionContext;
		const command = pi.commands.get("mcp-status");
		if (!command) throw new Error("mcp-status command missing");
		await command.handler("", ctx);

		expect(pi.activeTools.has("mcp__dynamic__search")).toBe(true);
	});

	it("persists a schema discovered by a later tool-triggered reconnect", async () => {
		const { cachePath } = writeConfig({ Recovery: { command: "mock-mcp" } });
		writeCache(cachePath, "Recovery", [tool("search")]);
		const failed = createPlan([], { pending: true });
		failed.connect.reject(new Error("initial failure"));
		sdkMock.plans.push(failed);
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);
		await startBackgroundConnect(process.cwd());

		const recoveredTool = { ...tool("search"), description: "recovered schema" };
		sdkMock.plans.push(createPlan([recoveredTool]));
		const registered = pi.tools.get("mcp__recovery__search");
		if (!registered) throw new Error("cached recovery tool missing");
		await registered.execute("call", {}, undefined, undefined, createContext([]));

		await vi.waitFor(() => {
			const persisted = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as McpToolCache;
			expect(persisted.servers.Recovery?.tools[0]?.description).toBe("recovered schema");
		});
	});

	it("merges the latest on-disk cache before persisting live discoveries", async () => {
		const { cachePath } = writeConfig({ Alpha: { command: "alpha" }, Beta: { command: "beta" } });
		const alpha = normalizeServer("Alpha", { command: "alpha" });
		const beta = normalizeServer("Beta", { command: "beta" });
		if (!alpha || !beta) throw new Error("failed to normalize merge servers");
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);

		const externalCache: McpToolCache = {
			version: 1,
			configFingerprint: buildConfigFingerprint([alpha, beta]),
			servers: {
				Beta: { updatedAt: "2026-07-14T00:00:00.000Z", tools: [tool("external_beta")] },
			},
		};
		saveMcpToolCache(externalCache, cachePath);
		const betaFailure = createPlan([], { pending: true });
		betaFailure.connect.reject(new Error("beta unavailable"));
		sdkMock.plans.push(createPlan([tool("live_alpha")]), betaFailure);

		await startBackgroundConnect(process.cwd());
		await vi.waitFor(() => {
			const persisted = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as McpToolCache;
			expect(persisted.servers.Alpha?.tools[0]?.name).toBe("live_alpha");
			expect(persisted.servers.Beta?.tools[0]?.name).toBe("external_beta");
		});
	});

	it("keeps a live session's tools connected when another Pi session initializes the bridge", async () => {
		writeConfig({ Creatrip: { command: "creatrip" } });
		const firstPlan = createPlan([tool("slack_getThreadReplies")]);
		firstPlan.callResult = { content: [{ type: "text", text: "first session result" }] };
		sdkMock.plans.push(firstPlan);
		const firstPi = createMockPi();
		runtimes.push(firstPi);
		await claudeMcpBridge(firstPi.api);
		await startBackgroundConnect(process.cwd());
		const firstTool = firstPi.tools.get("mcp__creatrip__slack_getthreadreplies");
		if (!firstTool) throw new Error("first session MCP tool missing");

		sdkMock.plans.push(createPlan([tool("slack_getThreadReplies")]));
		const secondPi = createMockPi();
		runtimes.push(secondPi);
		await claudeMcpBridge(secondPi.api);
		await startBackgroundConnect(process.cwd());

		await expect(firstTool.execute("call", {}, undefined, undefined, createContext([]))).resolves.toMatchObject({
			content: [{ type: "text", text: "first session result" }],
		});
	});

	it("ignores an old generation that completes after reload", async () => {
		const { configPath } = writeConfig({ Old: { command: "old" } });
		const oldPlan = createPlan([tool("old_tool")], { pending: true, ignoreAbort: true });
		sdkMock.plans.push(oldPlan);
		const oldPi = createMockPi();
		runtimes.push(oldPi);
		await claudeMcpBridge(oldPi.api);
		const oldBackground = startBackgroundConnect(process.cwd());
		await vi.waitFor(() => expect(sdkMock.clients).toHaveLength(1));
		await shutdown(oldPi);

		fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { New: { command: "new" } } }), "utf-8");
		const newPlan = createPlan([tool("new_tool")]);
		sdkMock.plans.push(newPlan);
		const newPi = createMockPi();
		runtimes.push(newPi);
		await claudeMcpBridge(newPi.api);
		const newBackground = startBackgroundConnect(process.cwd());

		oldPlan.connect.resolve(undefined);
		await oldBackground;
		await newBackground;
		expect(oldPi.tools.has("mcp__old__old_tool")).toBe(false);
		expect(newPi.tools.has("mcp__new__new_tool")).toBe(true);
	});

	it("does not create a late transport after a connection is disposed", async () => {
		const server = normalizeServer("Late", { command: "mock-mcp" });
		if (!server) throw new Error("failed to normalize late server");
		sdkMock.plans.push(createPlan([], { pending: true }));
		const connection = new McpConnection(server);

		const connecting = connection.connect();
		const disposing = connection.dispose();
		await Promise.allSettled([connecting, disposing]);

		expect(sdkMock.clients).toHaveLength(0);
		expect(sdkMock.transports).toHaveLength(0);
	});

	it("does not register tools when shutdown races with connection completion", async () => {
		writeConfig({ Closing: { command: "closing" } });
		const plan = createPlan([tool("late_tool")], { pending: true, ignoreAbort: true });
		sdkMock.plans.push(plan);
		const pi = createMockPi();
		runtimes.push(pi);
		await claudeMcpBridge(pi.api);
		const background = startBackgroundConnect(process.cwd());

		const shutdownPromise = shutdown(pi);
		plan.connect.resolve(undefined);
		await background;
		await shutdownPromise;
		expect(pi.tools.has("mcp__closing__late_tool")).toBe(false);
	});
});
