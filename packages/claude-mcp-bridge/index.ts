import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@sinclair/typebox";

export type RawMcpServer = {
	type?: string;
	enabled?: boolean;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
};

export type NormalizedMcpServer =
	| {
			name: string;
			type: "stdio";
			enabled: boolean;
			command: string;
			args: string[];
			env: Record<string, string>;
			cwd?: string;
	  }
	| {
			name: string;
			type: "sse" | "http";
			enabled: boolean;
			url: string;
			headers: Record<string, string>;
	  };

export type DiscoveredTool = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
};

export type ServerStatus = "connecting" | "connected" | "disconnected" | "error";

type McpTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

type ConnectOptions = {
	signal?: AbortSignal;
	timeoutMs?: number;
};

type ToolCallOptions = ConnectOptions & {
	onConnecting?: () => void;
	expectedInputSchema?: Record<string, unknown>;
};

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

function readPositiveIntEnv(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function connectionTimeoutMs(): number {
	return readPositiveIntEnv("PI_MCP_CONNECT_TIMEOUT_MS", DEFAULT_CONNECTION_TIMEOUT_MS);
}

function toolTimeoutMs(): number {
	return readPositiveIntEnv("PI_MCP_TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS);
}

function isOfflineMode(): boolean {
	return process.env.PI_OFFLINE === "1";
}

function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Cancelled"));

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("Cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve(false), timeoutMs);
		promise.then(
			() => {
				clearTimeout(timeout);
				resolve(true);
			},
			() => {
				clearTimeout(timeout);
				resolve(true);
			},
		);
	});
}

function isTimeoutError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase();
	return message.includes("timed out") || message.includes("timeout") || message.includes("requesttimeout");
}

export class McpConnection {
	private static readonly MAX_RECONNECT_ATTEMPTS = 5;
	private static readonly INITIAL_RECONNECT_DELAY_MS = 2_000;
	private static readonly MAX_RECONNECT_DELAY_MS = 30_000;

	private client: Client | null = null;
	private transport: McpTransport | null = null;
	private intentionalDisconnect = false;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private connectingPromise: Promise<void> | null = null;
	private connectController: AbortController | null = null;
	private connectAttempt = 0;
	private disposed = false;

	public status: ServerStatus = "disconnected";
	public error?: string;
	public tools: DiscoveredTool[] = [];
	public toolsCached = false;

	constructor(
		public readonly server: NormalizedMcpServer,
		private readonly onStateChange: () => void = () => {},
	) {}

	primeCachedTools(tools: DiscoveredTool[]): void {
		if (this.status === "connected") return;
		this.tools = tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
		this.toolsCached = this.tools.length > 0;
		this.onStateChange();
	}

	connect(options: ConnectOptions = {}): Promise<void> {
		if (this.disposed) return Promise.reject(new Error(`MCP server '${this.server.name}' is shut down`));
		if (isOfflineMode()) return Promise.reject(new Error("offline mode is enabled"));
		if (this.status === "connected" && this.client) return Promise.resolve();
		if (this.connectingPromise) return waitForPromise(this.connectingPromise, options.signal);

		this.clearReconnectTimer();
		const attempt = ++this.connectAttempt;
		const controller = new AbortController();
		this.connectController = controller;
		this.setState("connecting");

		const promise = this.doConnect(attempt, controller, options.timeoutMs ?? connectionTimeoutMs());
		this.connectingPromise = promise;
		const clear = () => {
			if (this.connectingPromise === promise) this.connectingPromise = null;
			if (this.connectController === controller) this.connectController = null;
		};
		promise.then(clear, clear);
		return waitForPromise(promise, options.signal);
	}

	async disconnect(options: { clearTools?: boolean } = {}): Promise<void> {
		this.intentionalDisconnect = true;
		this.clearReconnectTimer();
		this.connectAttempt++;
		this.connectController?.abort(new Error("MCP connection closed"));
		const pending = this.connectingPromise;
		if (pending) await pending.catch(() => undefined);
		await this.cleanupConnection();
		if (options.clearTools) {
			this.tools = [];
			this.toolsCached = false;
		}
		this.intentionalDisconnect = false;
		if (!this.disposed) this.setState("disconnected");
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.disconnect({ clearTools: true });
	}

	async ensureConnected(options: ToolCallOptions = {}): Promise<void> {
		if (isOfflineMode()) {
			throw new Error(`MCP server '${this.server.name}' is unavailable: offline mode is enabled`);
		}
		if (this.status === "connected" && this.client) return;

		options.onConnecting?.();
		this.clearReconnectTimer();
		this.reconnectAttempts = 0;

		try {
			if (this.connectingPromise) {
				await waitForPromise(this.connectingPromise, options.signal);
			} else {
				await this.connect(options);
			}
		} catch (error) {
			if (isTimeoutError(error)) {
				throw new Error(`MCP server '${this.server.name}' is unavailable: connection timed out`);
			}
			if (options.signal?.aborted) {
				throw new Error(`MCP server '${this.server.name}' connection was cancelled`);
			}
			throw new Error(`MCP server '${this.server.name}' is unavailable: ${errorMessage(error)}`);
		}

		if (!this.client || this.status !== "connected") {
			throw new Error(`MCP server '${this.server.name}' is unavailable: ${this.error ?? `status is ${this.status}`}`);
		}
	}

	async callTool(toolName: string, args: Record<string, unknown>, options: ToolCallOptions = {}): Promise<unknown> {
		await this.ensureConnected(options);
		if (!this.client || this.status !== "connected") {
			throw new Error(`MCP server '${this.server.name}' is unavailable`);
		}

		const liveTool = this.tools.find((tool) => tool.name === toolName);
		if (!liveTool) {
			throw new Error(`MCP tool '${this.server.name}/${toolName}' is no longer advertised by the server`);
		}
		if (
			options.expectedInputSchema &&
			stableStringify(options.expectedInputSchema) !== stableStringify(liveTool.inputSchema)
		) {
			throw new Error(`MCP tool '${this.server.name}/${toolName}' changed schema while connecting; retry the call`);
		}

		return this.client.callTool({ name: toolName, arguments: args }, undefined, {
			signal: options.signal,
			timeout: options.timeoutMs ?? toolTimeoutMs(),
		});
	}

	private async doConnect(attempt: number, controller: AbortController, timeoutMs: number): Promise<void> {
		this.intentionalDisconnect = true;
		await this.cleanupConnection();
		this.intentionalDisconnect = false;

		let client: Client | null = null;
		let transport: McpTransport | null = null;
		let timeout: ReturnType<typeof setTimeout> | null = null;
		try {
			if (this.disposed || attempt !== this.connectAttempt || controller.signal.aborted) {
				throw controller.signal.reason ?? new Error("MCP connection superseded");
			}

			client = new Client({ name: "pi-claude-mcp-bridge", version: "0.1.0" }, { capabilities: {} });
			transport = this.createTransport();
			const deadline = Date.now() + timeoutMs;
			timeout = setTimeout(() => controller.abort(new Error("connection timed out")), timeoutMs);

			await waitForPromise(
				client.connect(transport, { signal: controller.signal, timeout: timeoutMs }),
				controller.signal,
			);
			const remainingMs = Math.max(1, deadline - Date.now());
			const result = await waitForPromise(
				client.listTools(undefined, { signal: controller.signal, timeout: remainingMs }),
				controller.signal,
			);
			if (this.disposed || attempt !== this.connectAttempt || controller.signal.aborted) {
				throw controller.signal.reason ?? new Error("MCP connection superseded");
			}

			this.client = client;
			this.transport = transport;
			this.tools = result.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
			}));
			this.toolsCached = false;
			this.reconnectAttempts = 0;
			this.installConnectionHandlers(client, transport);
			this.setState("connected");
		} catch (error) {
			if (client && transport && this.client !== client) await this.cleanupLocal(client, transport);
			if (this.disposed || attempt !== this.connectAttempt) throw error;
			const message = isTimeoutError(error) ? "connection timed out" : errorMessage(error);
			this.setState("error", message);
			this.scheduleReconnect(false);
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	private createTransport(): McpTransport {
		if (this.server.type === "stdio") {
			return new StdioClientTransport({
				command: this.server.command,
				args: this.server.args,
				env: this.server.env,
				cwd: this.server.cwd,
				stderr: process.env.PI_MCP_STDERR === "inherit" ? "inherit" : "ignore",
			});
		}

		if (this.server.type === "sse") {
			const sseHeaders = this.server.headers;
			return new SSEClientTransport(new URL(this.server.url), {
				eventSourceInit:
					Object.keys(sseHeaders).length > 0
						? {
								fetch: (url, init) =>
									fetch(url, {
										...init,
										headers: { ...init.headers, ...sseHeaders },
									}),
							}
						: undefined,
				requestInit: { headers: sseHeaders },
			});
		}

		return new StreamableHTTPClientTransport(new URL(this.server.url), {
			requestInit: { headers: this.server.headers },
		});
	}

	private installConnectionHandlers(client: Client, transport: McpTransport): void {
		client.onclose = () => {
			if (this.intentionalDisconnect || this.disposed || this.client !== client) return;
			this.client = null;
			this.transport = null;
			this.setState("disconnected");
			this.scheduleReconnect();
		};

		client.onerror = (error: Error) => {
			if (this.intentionalDisconnect || this.disposed || this.client !== client) return;
			const message = errorMessage(error);
			if (message.includes("unknown message ID")) return;
			this.error = message;
			this.onStateChange();
		};

		this.transport = transport;
	}

	private async cleanupLocal(client: Client, transport: McpTransport): Promise<void> {
		let clientCloseFailed = false;
		const closeClient = client.close().catch(() => {
			clientCloseFailed = true;
		});
		if ((await settlesWithin(closeClient, 1_000)) && !clientCloseFailed) return;
		await settlesWithin(transport.close(), 1_000);
	}

	private async cleanupConnection(): Promise<void> {
		const client = this.client;
		const transport = this.transport;
		this.client = null;
		this.transport = null;
		if (client && transport) {
			await this.cleanupLocal(client, transport);
			return;
		}
		if (transport) {
			try {
				await transport.close();
			} catch {
				/* ignore */
			}
		}
	}

	private setState(status: ServerStatus, error?: string): void {
		this.status = status;
		this.error = error;
		this.onStateChange();
	}

	private clearReconnectTimer(): void {
		if (!this.reconnectTimer) return;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private scheduleReconnect(markConnecting = true): void {
		this.clearReconnectTimer();
		if (this.disposed || this.intentionalDisconnect || isOfflineMode()) return;

		if (this.reconnectAttempts >= McpConnection.MAX_RECONNECT_ATTEMPTS) {
			this.setState(
				"error",
				`Reconnection failed after ${McpConnection.MAX_RECONNECT_ATTEMPTS} attempts for '${this.server.name}'`,
			);
			return;
		}

		const delay = Math.min(
			McpConnection.INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
			McpConnection.MAX_RECONNECT_DELAY_MS,
		);
		this.reconnectAttempts++;
		if (markConnecting) this.setState("connecting");
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect().catch(() => undefined);
		}, delay);
	}
}

export class McpManager {
	private connections = new Map<string, McpConnection>();
	public sourcePath: string | null = null;

	constructor(private readonly onStateChange: () => void = () => {}) {}

	configureServers(servers: NormalizedMcpServer[], sourcePath: string | null): void {
		this.connections.clear();
		for (const server of servers) {
			this.connections.set(server.name, new McpConnection(server, this.onStateChange));
		}
		this.sourcePath = sourcePath;
		this.onStateChange();
	}

	primeCachedTools(servers: Record<string, { tools: DiscoveredTool[] }>): void {
		for (const [serverName, cached] of Object.entries(servers)) {
			this.connections.get(serverName)?.primeCachedTools(cached.tools);
		}
	}

	async connectAll(options: ConnectOptions = {}): Promise<void> {
		const connections = Array.from(this.connections.values()).filter((connection) => connection.server.enabled);
		await Promise.allSettled(connections.map((connection) => connection.connect(options)));
	}

	async disconnectAll(): Promise<void> {
		await Promise.allSettled(Array.from(this.connections.values()).map((connection) => connection.disconnect()));
	}

	async dispose(): Promise<void> {
		await Promise.allSettled(Array.from(this.connections.values()).map((connection) => connection.dispose()));
		this.connections.clear();
	}

	getStates(): Array<{
		name: string;
		status: ServerStatus;
		type: NormalizedMcpServer["type"];
		toolCount: number;
		cached: boolean;
		error?: string;
	}> {
		return Array.from(this.connections.values()).map((conn) => ({
			name: conn.server.name,
			status: conn.status,
			type: conn.server.type,
			toolCount: conn.tools.length,
			cached: conn.toolsCached,
			error: conn.error,
		}));
	}

	getAllTools(): Array<{ serverName: string; tool: DiscoveredTool }> {
		const tools: Array<{ serverName: string; tool: DiscoveredTool }> = [];
		for (const conn of this.connections.values()) {
			for (const tool of conn.tools) tools.push({ serverName: conn.server.name, tool });
		}
		return tools;
	}

	getStatus(serverName: string): ServerStatus | undefined {
		return this.connections.get(serverName)?.status;
	}

	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
		options: ToolCallOptions = {},
	): Promise<unknown> {
		const conn = this.connections.get(serverName);
		if (!conn) throw new Error(`MCP server '${serverName}' not found`);
		return conn.callTool(toolName, args, options);
	}

	async reconnectServer(name: string, options: ConnectOptions = {}): Promise<void> {
		if (isOfflineMode()) throw new Error("offline mode is enabled");
		const conn = this.connections.get(name);
		if (!conn) return;
		await conn.disconnect();
		await conn.connect(options);
	}

	getServerTools(name: string): DiscoveredTool[] {
		const conn = this.connections.get(name);
		if (!conn) return [];
		return [...conn.tools];
	}
}

type LoadedConfig = {
	sourcePath: string | null;
	servers: NormalizedMcpServer[];
	warnings: string[];
};

export interface McpToolCache {
	version: 1;
	configFingerprint: string;
	servers: Record<
		string,
		{
			updatedAt: string;
			tools: DiscoveredTool[];
		}
	>;
}

const DEFAULT_MCP_TOOL_CACHE_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"cache",
	"claude-mcp-bridge",
	"tools-v1.json",
);

function mcpToolCachePath(): string {
	const override = process.env.PI_MCP_CACHE_PATH;
	return override ? path.resolve(expandEnvVars(override)) : DEFAULT_MCP_TOOL_CACHE_PATH;
}

function stableJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableJsonValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => [key, stableJsonValue(entry)]),
	);
}

function stableStringify(value: unknown): string {
	return JSON.stringify(stableJsonValue(value));
}

function commandArgumentStructure(value: string): string {
	const envRedacted = value.replace(/\$\{[^}]+\}/g, "<env>");
	const inlineFlag = envRedacted.match(/^(--?[a-zA-Z0-9_-]+)=/);
	if (inlineFlag) return `${inlineFlag[1]}=<value>`;
	if (/^--?[a-zA-Z0-9_-]+$/.test(envRedacted)) return envRedacted;
	if (/^[a-zA-Z]:[\\/]|[\\/]/.test(envRedacted)) return `<path:${path.extname(envRedacted) || "none"}>`;
	return "<value>";
}

export function buildConfigFingerprint(servers: NormalizedMcpServer[]): string {
	const safeShape = [...servers]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((server) => {
			if (server.type === "stdio") {
				return {
					name: server.name,
					type: server.type,
					command: path.basename(server.command),
					args: server.args.map(commandArgumentStructure),
				};
			}

			let host = "invalid";
			try {
				host = new URL(server.url).host;
			} catch {
				/* keep invalid marker */
			}
			return { name: server.name, type: server.type, host };
		});

	return createHash("sha256").update(stableStringify(safeShape)).digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUsableInputSchema(value: unknown): value is Record<string, unknown> {
	if (!isPlainRecord(value)) return false;
	if (value.type !== undefined && typeof value.type !== "string") return false;
	if (value.required !== undefined) {
		if (!Array.isArray(value.required) || !value.required.every((entry) => typeof entry === "string")) return false;
	}
	if (value.properties !== undefined) {
		if (!isPlainRecord(value.properties)) return false;
		for (const property of Object.values(value.properties)) {
			if (!isPlainRecord(property)) return false;
			if (property.type !== undefined && typeof property.type !== "string") return false;
			if (property.description !== undefined && typeof property.description !== "string") return false;
			if (property.enum !== undefined && !Array.isArray(property.enum)) return false;
			if (property.items !== undefined && !isPlainRecord(property.items)) return false;
		}
	}
	return true;
}

function parseCachedTool(value: unknown): DiscoveredTool | null {
	if (!isPlainRecord(value)) return null;
	if (typeof value.name !== "string" || !isUsableInputSchema(value.inputSchema)) return null;
	if (value.description !== undefined && typeof value.description !== "string") return null;
	return {
		name: value.name,
		description: value.description as string | undefined,
		inputSchema: value.inputSchema,
	};
}

export function loadMcpToolCache(
	configFingerprint: string,
	cachePath: string = mcpToolCachePath(),
): McpToolCache | null {
	const parsed = safeReadJson(cachePath);
	if (!parsed || typeof parsed !== "object") return null;
	const candidate = parsed as Record<string, unknown>;
	if (candidate.version !== 1 || candidate.configFingerprint !== configFingerprint) return null;
	if (!candidate.servers || typeof candidate.servers !== "object" || Array.isArray(candidate.servers)) return null;

	const servers: McpToolCache["servers"] = {};
	for (const [serverName, rawEntry] of Object.entries(candidate.servers as Record<string, unknown>)) {
		if (!rawEntry || typeof rawEntry !== "object") return null;
		const entry = rawEntry as Record<string, unknown>;
		if (typeof entry.updatedAt !== "string" || !Array.isArray(entry.tools)) return null;
		const tools = entry.tools.map(parseCachedTool);
		if (tools.some((tool) => tool === null)) return null;
		servers[serverName] = { updatedAt: entry.updatedAt, tools: tools as DiscoveredTool[] };
	}

	return { version: 1, configFingerprint, servers };
}

export function saveMcpToolCache(cache: McpToolCache, cachePath: string = mcpToolCachePath()): void {
	fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
	const tempPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(tempPath, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tempPath, cachePath);
	} finally {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			/* already renamed or never written */
		}
	}
}

const CACHE_LOCK_TIMEOUT_MS = 2_000;

function cacheEntryTimestamp(entry: McpToolCache["servers"][string]): number {
	const timestamp = Date.parse(entry.updatedAt);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function mergeToolCaches(current: McpToolCache | null, next: McpToolCache): McpToolCache {
	if (!current || current.configFingerprint !== next.configFingerprint) return next;
	const servers: McpToolCache["servers"] = { ...current.servers };
	for (const [serverName, nextEntry] of Object.entries(next.servers)) {
		const currentEntry = servers[serverName];
		if (!currentEntry || cacheEntryTimestamp(nextEntry) >= cacheEntryTimestamp(currentEntry)) {
			servers[serverName] = nextEntry;
		}
	}
	return { version: 1, configFingerprint: next.configFingerprint, servers };
}

async function acquireCacheLock(cachePath: string): Promise<{ close: () => Promise<void> }> {
	fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
	const lockPath = `${cachePath}.lock`;
	const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS;

	while (true) {
		try {
			const handle = await fs.promises.open(lockPath, "wx", 0o600);
			try {
				await handle.writeFile(`${process.pid} ${Date.now()}\n`, "utf-8");
			} catch (error) {
				await handle.close().catch(() => undefined);
				await fs.promises.unlink(lockPath).catch(() => undefined);
				throw error;
			}
			return {
				close: async () => {
					await handle.close().catch(() => undefined);
					await fs.promises.unlink(lockPath).catch(() => undefined);
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for MCP tool cache lock: ${lockPath}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

export async function mergeAndSaveMcpToolCache(
	next: McpToolCache,
	cachePath: string = mcpToolCachePath(),
): Promise<McpToolCache> {
	const lock = await acquireCacheLock(cachePath);
	try {
		const merged = mergeToolCaches(loadMcpToolCache(next.configFingerprint, cachePath), next);
		saveMcpToolCache(merged, cachePath);
		return merged;
	} finally {
		await lock.close();
	}
}

type ToolVisibilitySettingsFile = {
	disabledTools?: Record<string, string[]> | string[];
};

type LoadedToolVisibilitySettings = {
	disabledToolKeys: Set<string>;
	warning?: string;
};

const TOOL_VISIBILITY_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "claude-mcp-bridge-tools.json");
export const TOOL_VISIBILITY_KEY_SEPARATOR = "\u001f";

export function buildToolVisibilityKey(serverName: string, toolName: string): string {
	return `${serverName}${TOOL_VISIBILITY_KEY_SEPARATOR}${toolName}`;
}

export function parseToolVisibilityKey(key: string): { serverName: string; toolName: string } | null {
	const separatorIndex = key.indexOf(TOOL_VISIBILITY_KEY_SEPARATOR);
	if (separatorIndex <= 0 || separatorIndex >= key.length - 1) return null;

	const serverName = key.slice(0, separatorIndex).trim();
	const toolName = key.slice(separatorIndex + TOOL_VISIBILITY_KEY_SEPARATOR.length).trim();
	if (!serverName || !toolName) return null;

	return { serverName, toolName };
}

function addDisabledToolKey(result: Set<string>, serverNameRaw: string, toolNameRaw: string): void {
	const serverName = serverNameRaw.trim();
	const toolName = toolNameRaw.trim();
	if (!serverName || !toolName) return;
	result.add(buildToolVisibilityKey(serverName, toolName));
}

function parseDisabledToolList(value: string[]): Set<string> {
	const result = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const separatorIndex = item.indexOf("/");
		if (separatorIndex <= 0 || separatorIndex >= item.length - 1) continue;
		addDisabledToolKey(result, item.slice(0, separatorIndex), item.slice(separatorIndex + 1));
	}
	return result;
}

function parseDisabledToolMap(value: Record<string, unknown>): Set<string> {
	const result = new Set<string>();
	for (const [serverNameRaw, tools] of Object.entries(value)) {
		if (!Array.isArray(tools)) continue;
		for (const toolNameRaw of tools) {
			if (typeof toolNameRaw !== "string") continue;
			addDisabledToolKey(result, serverNameRaw, toolNameRaw);
		}
	}
	return result;
}

export function parseDisabledToolKeys(value: unknown): Set<string> {
	if (!value) return new Set<string>();
	if (Array.isArray(value)) return parseDisabledToolList(value);
	if (typeof value !== "object") return new Set<string>();
	return parseDisabledToolMap(value as Record<string, unknown>);
}

function loadToolVisibilitySettings(
	settingsPath: string = TOOL_VISIBILITY_SETTINGS_PATH,
): LoadedToolVisibilitySettings {
	if (!fs.existsSync(settingsPath)) {
		return { disabledToolKeys: new Set<string>() };
	}

	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as ToolVisibilitySettingsFile;
		if (!parsed || typeof parsed !== "object") {
			return {
				disabledToolKeys: new Set<string>(),
				warning: `Invalid tool visibility settings format: ${settingsPath}`,
			};
		}
		return { disabledToolKeys: parseDisabledToolKeys(parsed.disabledTools) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			disabledToolKeys: new Set<string>(),
			warning: `Failed to load tool visibility settings (${settingsPath}): ${message}`,
		};
	}
}

export function serializeToolVisibilitySettings(disabledToolKeys: Set<string>): ToolVisibilitySettingsFile {
	const grouped = new Map<string, string[]>();

	for (const key of disabledToolKeys) {
		const parsed = parseToolVisibilityKey(key);
		if (!parsed) continue;

		const tools = grouped.get(parsed.serverName) ?? [];
		tools.push(parsed.toolName);
		grouped.set(parsed.serverName, tools);
	}

	const disabledTools: Record<string, string[]> = {};
	const sortedServers = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
	for (const serverName of sortedServers) {
		const tools = grouped.get(serverName) ?? [];
		const dedupedTools = Array.from(new Set(tools)).sort((a, b) => a.localeCompare(b));
		if (dedupedTools.length > 0) {
			disabledTools[serverName] = dedupedTools;
		}
	}

	return { disabledTools };
}

function saveToolVisibilitySettings(
	disabledToolKeys: Set<string>,
	settingsPath: string = TOOL_VISIBILITY_SETTINGS_PATH,
): { ok: true } | { ok: false; error: string } {
	try {
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		const payload = serializeToolVisibilitySettings(disabledToolKeys);
		fs.writeFileSync(settingsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}

function hasNewlyDisabledTools(before: Set<string>, after: Set<string>): boolean {
	for (const key of after) {
		if (!before.has(key)) return true;
	}
	return false;
}

export function expandEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "");
}

function expandRecord(input?: Record<string, string>): Record<string, string> {
	const output: Record<string, string> = {};
	if (!input) return output;
	for (const [k, v] of Object.entries(input)) {
		output[k] = expandEnvVars(v);
	}
	return output;
}

function safeReadJson(filePath: string): unknown | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export function extractRawServers(data: unknown): Record<string, RawMcpServer> | null {
	if (!data || typeof data !== "object") return null;
	const record = data as Record<string, unknown>;

	if (record.mcpServers && typeof record.mcpServers === "object") {
		return record.mcpServers as Record<string, RawMcpServer>;
	}

	const mcp = record.mcp as Record<string, unknown> | undefined;
	if (mcp?.servers && typeof mcp.servers === "object") {
		return mcp.servers as Record<string, RawMcpServer>;
	}

	if (record.servers && typeof record.servers === "object") {
		return record.servers as Record<string, RawMcpServer>;
	}

	return null;
}

export function normalizeServer(name: string, raw: RawMcpServer): NormalizedMcpServer | null {
	if (raw.enabled === false) return null;
	const type = raw.type?.toLowerCase();

	if (raw.command || type === "stdio") {
		if (!raw.command) return null;

		const envFromProcess: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (typeof v === "string") envFromProcess[k] = v;
		}

		return {
			name,
			type: "stdio",
			enabled: true,
			command: expandEnvVars(raw.command),
			args: (raw.args ?? []).map(expandEnvVars),
			env: { ...envFromProcess, ...expandRecord(raw.env) },
			cwd: raw.cwd ? expandEnvVars(raw.cwd) : undefined,
		};
	}

	if (raw.url) {
		const expandedUrl = expandEnvVars(raw.url);
		const headers = expandRecord(raw.headers);
		const inferred =
			type === "sse" ? "sse" : type === "http" ? "http" : /\/sse(?:\/)?(?:\?|$)/i.test(expandedUrl) ? "sse" : "http";

		return {
			name,
			type: inferred,
			enabled: true,
			url: expandedUrl,
			headers,
		};
	}

	return null;
}

function collectScopedConfigCandidates(cwd: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();

	const push = (candidate: string): void => {
		const resolved = path.resolve(candidate);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		candidates.push(resolved);
	};

	let current = path.resolve(cwd);
	const home = path.resolve(os.homedir());
	const root = path.parse(current).root;

	while (true) {
		push(path.join(current, ".pi", "mcp.json"));
		push(path.join(current, ".mcp.json"));
		push(path.join(current, "backend", ".mcp.json"));
		push(path.join(current, "frontend", ".mcp.json"));

		if (current === home || current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	push(path.join(os.homedir(), ".mcp.json"));
	push(path.join(os.homedir(), ".claude.json"));

	return candidates;
}

function loadConfig(cwd: string): LoadedConfig {
	const warnings: string[] = [];

	const explicitPath = process.env.PI_MCP_CONFIG;
	const candidates = explicitPath ? [path.resolve(expandEnvVars(explicitPath))] : collectScopedConfigCandidates(cwd);

	const loadedSources: string[] = [];
	const serversByName = new Map<string, NormalizedMcpServer>();

	for (const candidate of candidates) {
		const parsed = safeReadJson(candidate);
		if (!parsed) continue;

		const rawServers = extractRawServers(parsed);
		if (!rawServers || Object.keys(rawServers).length === 0) continue;
		loadedSources.push(candidate);

		for (const [name, raw] of Object.entries(rawServers)) {
			if (serversByName.has(name)) {
				warnings.push(`Skipped duplicate MCP server config: ${name} (from ${candidate})`);
				continue;
			}

			const normalized = normalizeServer(name, raw);
			if (normalized) serversByName.set(name, normalized);
			else warnings.push(`Skipped invalid MCP server config: ${name}`);
		}
	}

	return {
		sourcePath: loadedSources.length > 0 ? loadedSources.join(", ") : null,
		servers: Array.from(serversByName.values()),
		warnings,
	};
}

export function sanitizeName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
}

export function buildPiToolName(serverName: string, toolName: string): string {
	const safeServer = sanitizeName(serverName) || "server";
	const safeTool = sanitizeName(toolName) || "tool";
	return `mcp__${safeServer}__${safeTool}`;
}

export function mimeToExt(mimeType: string): string {
	switch (mimeType) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		case "image/svg+xml":
			return "svg";
		default:
			return "png";
	}
}

type FormattedToolResult = { text: string; imagePaths: string[] };

type PreparedPayload = {
	text: string;
	truncated: boolean;
	fullPayloadPath?: string;
	originalLength: number;
};

const LARGE_PAYLOAD_THRESHOLD_CHARS = 30_000;
const LARGE_PAYLOAD_PREVIEW_CHARS = 1_000;

function preparePayloadForClient(text: string, serverName: string, toolName: string): PreparedPayload {
	const originalLength = text.length;
	if (originalLength <= LARGE_PAYLOAD_THRESHOLD_CHARS) {
		return { text, truncated: false, originalLength };
	}

	const preview = text.slice(0, LARGE_PAYLOAD_PREVIEW_CHARS);
	const fileName = `mcp-payload-${sanitizeName(serverName) || "server"}-${sanitizeName(toolName) || "tool"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
	const filePath = path.join(os.tmpdir(), fileName);

	try {
		fs.writeFileSync(filePath, text, "utf-8");
		return {
			text: [
				preview,
				"",
				`[Truncated output: first ${LARGE_PAYLOAD_PREVIEW_CHARS} chars shown, ${originalLength - LARGE_PAYLOAD_PREVIEW_CHARS} chars omitted]`,
				`[Full payload saved to: ${filePath}]`,
				"Use Read tool (or another file reader) to inspect the full payload.",
			].join("\n"),
			truncated: true,
			fullPayloadPath: filePath,
			originalLength,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			text: [
				preview,
				"",
				`[Truncated output: first ${LARGE_PAYLOAD_PREVIEW_CHARS} chars shown, ${originalLength - LARGE_PAYLOAD_PREVIEW_CHARS} chars omitted]`,
				`[Failed to save full payload: ${message}]`,
			].join("\n"),
			truncated: true,
			originalLength,
		};
	}
}

export function formatToolResult(result: unknown): FormattedToolResult {
	const imagePaths: string[] = [];

	if (typeof result === "string") return { text: result, imagePaths };

	if (result && typeof result === "object") {
		const maybe = result as {
			content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
			structuredContent?: unknown;
		};

		if (Array.isArray(maybe.content)) {
			const chunks = maybe.content
				.map((item) => {
					if (item?.type === "text") return item.text ?? "";
					if (item?.type === "image" && item.data) {
						const ext = mimeToExt(item.mimeType ?? "image/png");
						const tmpFile = path.join(
							os.tmpdir(),
							`mcp-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`,
						);
						try {
							fs.writeFileSync(tmpFile, Buffer.from(item.data, "base64"));
							imagePaths.push(tmpFile);
							return `[Image saved: ${tmpFile}]`;
						} catch {
							return `[Image save failed: ${item.mimeType}, ${item.data.length} chars]`;
						}
					}
					return JSON.stringify(item);
				})
				.filter(Boolean);
			if (chunks.length > 0) return { text: chunks.join("\n"), imagePaths };
		}

		if (maybe.structuredContent !== undefined) {
			return { text: JSON.stringify(maybe.structuredContent, null, 2), imagePaths };
		}
	}

	return { text: JSON.stringify(result, null, 2), imagePaths };
}

type JsonSchemaProp = {
	type?: string;
	description?: string;
	enum?: unknown[];
	items?: { type?: string };
};

/**
 * Map a single JSON Schema property to the appropriate TypeBox type.
 * Preserves type, description, and enum information so the LLM receives
 * accurate type hints and the framework can validate/coerce values.
 */
function mapPropertyType(prop: JsonSchemaProp): ReturnType<typeof Type.Any> {
	const opts: Record<string, unknown> = {};
	if (typeof prop.description === "string") opts.description = prop.description;

	switch (prop.type) {
		case "string":
			if (Array.isArray(prop.enum) && prop.enum.every((v): v is string => typeof v === "string")) {
				return Type.Union(
					prop.enum.map((v) => Type.Literal(v)),
					opts,
				) as unknown as ReturnType<typeof Type.Any>;
			}
			return Type.String(opts) as unknown as ReturnType<typeof Type.Any>;
		case "boolean":
			return Type.Boolean(opts) as unknown as ReturnType<typeof Type.Any>;
		case "number":
			return Type.Number(opts) as unknown as ReturnType<typeof Type.Any>;
		case "integer":
			return Type.Integer(opts) as unknown as ReturnType<typeof Type.Any>;
		case "array":
			return Type.Array(Type.Any(), opts) as unknown as ReturnType<typeof Type.Any>;
		default:
			return Type.Any(opts);
	}
}

export function createParameterSchema(inputSchema: Record<string, unknown>): ReturnType<typeof Type.Object> {
	const schema = inputSchema as {
		type?: string;
		properties?: Record<string, JsonSchemaProp>;
		required?: string[];
	};

	if (schema.type !== "object" || !schema.properties) {
		return Type.Object({});
	}

	const required = new Set(schema.required ?? []);
	const properties: Record<string, ReturnType<typeof Type.Any>> = {};

	for (const [key, prop] of Object.entries(schema.properties)) {
		const base = mapPropertyType(prop);

		if (required.has(key)) {
			properties[key] = base;
		} else {
			properties[key] = Type.Optional(base) as unknown as ReturnType<typeof Type.Any>;
		}
	}

	return Type.Object(properties, { additionalProperties: true });
}

function summarizeToolCallArgs(args: Record<string, unknown>, theme: Theme): string {
	const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null);
	if (entries.length === 0) return "";

	const firstEntry = entries[0];
	if (!firstEntry) return "";

	const [, firstVal] = firstEntry;
	const str = typeof firstVal === "string" ? firstVal : JSON.stringify(firstVal);
	const display = str.length > 80 ? `${str.slice(0, 77)}…` : str;
	const extraCount = entries.length > 1 ? theme.fg("muted", ` +${entries.length - 1}`) : "";
	return ` ${theme.fg("accent", display)}${extraCount}`;
}

function renderMcpToolCall(serverName: string, toolName: string, args: unknown, theme: Theme): Text {
	const label = `${serverName}/${toolName}`;
	const params = args as Record<string, unknown>;
	const argText = summarizeToolCallArgs(params, theme);
	return new Text(`${theme.fg("toolTitle", theme.bold(label))}${argText}`, 0, 0);
}

function buildMcpToolResultContent(
	formatted: FormattedToolResult,
	prepared: PreparedPayload,
): Array<{ type: "text"; text: string }> {
	const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: prepared.text }];
	for (const imgPath of formatted.imagePaths) {
		content.push({ type: "text", text: `📎 Use Read tool to view: ${imgPath}` });
	}
	if (prepared.fullPayloadPath) {
		content.push({ type: "text", text: `📄 Full payload file: ${prepared.fullPayloadPath}` });
	}
	return content;
}

type ReloadableContext = ExtensionContext & { reload: () => Promise<void> };

async function executeMcpToolCall(args: {
	manager: McpManager;
	serverName: string;
	tool: DiscoveredTool;
	params: Record<string, unknown>;
	signal?: AbortSignal;
	isToolDisabled: (serverName: string, toolName: string) => boolean;
}) {
	const { manager, serverName, tool, params, signal, isToolDisabled } = args;
	if (signal?.aborted) {
		return {
			content: [{ type: "text" as const, text: "Cancelled" }],
			details: { server: serverName, tool: tool.name, cancelled: true },
		};
	}
	if (isToolDisabled(serverName, tool.name)) {
		throw new Error("This MCP tool is disabled. Open /mcp-status → Tools to enable it.");
	}

	try {
		const result = await manager.callTool(serverName, tool.name, params, {
			signal,
			expectedInputSchema: tool.inputSchema,
		});
		const formatted = formatToolResult(result);
		if ((result as { isError?: boolean })?.isError) {
			throw new Error(formatted.text || `MCP tool ${serverName}/${tool.name} returned an error`);
		}
		const prepared = preparePayloadForClient(formatted.text, serverName, tool.name);
		return {
			content: buildMcpToolResultContent(formatted, prepared),
			details: {
				server: serverName,
				tool: tool.name,
				raw: prepared.truncated ? undefined : result,
				payloadTruncated: prepared.truncated,
				payloadOriginalLength: prepared.originalLength,
				payloadFilePath: prepared.fullPayloadPath,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`MCP error (${serverName}/${tool.name}): ${message}`);
	}
}

// ── Overlay shared helpers ────────────────────────────────────

type McpServerState = {
	name: string;
	status: ServerStatus;
	type: string;
	toolCount: number;
	cached: boolean;
	error?: string;
};

type ServerAction = "tools" | "reconnect";

function sColor(status: ServerStatus): "success" | "error" | "warning" | "muted" {
	switch (status) {
		case "connected":
			return "success";
		case "error":
			return "error";
		case "disconnected":
			return "warning";
		default:
			return "muted";
	}
}

function sIcon(status: ServerStatus): string {
	switch (status) {
		case "connected":
			return "●";
		case "error":
			return "✗";
		case "disconnected":
			return "○";
		default:
			return "◐";
	}
}

function boxTop(th: Theme, title: string, innerW: number): string {
	const t = ` ${title} `;
	const tW = visibleWidth(t);
	const p1 = Math.floor((innerW - tW) / 2);
	const p2 = Math.max(0, innerW - tW - p1);
	return th.fg("border", `╭${"─".repeat(p1)}`) + th.fg("accent", th.bold(t)) + th.fg("border", `${"─".repeat(p2)}╮`);
}

function boxSep(th: Theme, innerW: number): string {
	return th.fg("border", `├${"─".repeat(innerW)}┤`);
}

function boxBot(th: Theme, innerW: number): string {
	return th.fg("border", `╰${"─".repeat(innerW)}╯`);
}

function boxRow(th: Theme, content: string, innerW: number): string {
	return th.fg("border", "│") + truncateToWidth(` ${content}`, innerW, "…", true) + th.fg("border", "│");
}

// ── Overlay 1: Server list (navigable) ───────────────────────

class McpStatusOverlay {
	private tui: TUI;
	private theme: Theme;
	private done: (value: string | null) => void;
	private states: McpServerState[];
	private sourcePath: string | null;
	private warnings: string[];
	private sel = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		done: (value: string | null) => void,
		states: McpServerState[],
		sourcePath: string | null,
		warnings: string[],
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.states = states;
		this.sourcePath = sourcePath;
		this.warnings = warnings;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done(null);
		} else if (matchesKey(data, "up") || data === "k") {
			this.sel = Math.max(0, this.sel - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.sel = Math.min(this.states.length - 1, this.sel + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			if (this.states.length > 0) this.done(this.states[this.sel]?.name);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const iW = Math.max(1, width - 2);
		const lines: string[] = [];

		lines.push(boxTop(th, "MCP Server Status", iW));
		if (this.sourcePath) {
			lines.push(boxRow(th, th.fg("muted", `Source: ${this.sourcePath}`), iW));
		}
		lines.push(boxSep(th, iW));

		for (let i = 0; i < this.states.length; i++) {
			const st = this.states[i];
			if (!st) continue;
			const c = sColor(st.status);
			const ico = sIcon(st.status);
			const sel = i === this.sel;
			const cursor = sel ? th.fg("accent", "▸") : " ";
			const name = sel ? th.fg("accent", th.bold(st.name)) : st.name;
			const tools = st.toolCount > 0 ? th.fg("muted", ` ${st.toolCount} tools`) : "";
			const cached = st.cached ? th.fg("muted", " cached") : "";
			const err = st.error ? `  ${th.fg("error", `⚠ ${st.error}`)}` : "";
			lines.push(
				boxRow(th, `${cursor} ${th.fg(c, ico)} ${name}  ${th.fg("muted", st.type)}${tools}${cached}${err}`, iW),
			);
		}

		if (this.warnings.length > 0) {
			lines.push(boxSep(th, iW));
			lines.push(boxRow(th, th.fg("warning", `⚠ ${this.warnings.length} warning(s)`), iW));
		}

		lines.push(boxSep(th, iW));
		lines.push(boxRow(th, th.fg("muted", "↑↓ navigate · enter select · ESC close"), iW));
		lines.push(boxBot(th, iW));
		return lines;
	}
}

// ── Overlay 2: Server action menu ────────────────────────────

class McpActionOverlay {
	private tui: TUI;
	private theme: Theme;
	private done: (value: ServerAction | null) => void;
	private state: McpServerState;
	private actions: Array<{ id: ServerAction; label: string; hint: string }> = [
		{ id: "tools", label: "Tools", hint: "Enable/disable tools" },
		{ id: "reconnect", label: "Reconnect", hint: "Disconnect & reconnect" },
	];
	private sel = 0;

	constructor(tui: TUI, theme: Theme, done: (value: ServerAction | null) => void, state: McpServerState) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.state = state;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(null);
		} else if (matchesKey(data, "up") || data === "k") {
			this.sel = Math.max(0, this.sel - 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "down") || data === "j") {
			this.sel = Math.min(this.actions.length - 1, this.sel + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "return")) {
			this.done(this.actions[this.sel]?.id);
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const iW = Math.max(1, width - 2);
		const st = this.state;
		const c = sColor(st.status);
		const ico = sIcon(st.status);
		const lines: string[] = [];

		lines.push(boxTop(th, st.name, iW));
		lines.push(boxRow(th, `${th.fg(c, `${ico} ${st.status}`)}  ${th.fg("muted", st.type)}`, iW));
		if (st.toolCount > 0) {
			const source = st.cached ? "cached" : "live";
			lines.push(boxRow(th, th.fg("muted", `${st.toolCount} tools registered · ${source}`), iW));
		}
		if (st.error) {
			lines.push(boxRow(th, th.fg("error", `⚠ ${st.error}`), iW));
		}
		lines.push(boxSep(th, iW));

		for (let i = 0; i < this.actions.length; i++) {
			const a = this.actions[i];
			if (!a) continue;
			const sel = i === this.sel;
			const cursor = sel ? th.fg("accent", "▸") : " ";
			const label = sel ? th.fg("accent", th.bold(a.label)) : a.label;
			lines.push(boxRow(th, `${cursor} ${label}  ${th.fg("muted", a.hint)}`, iW));
		}

		lines.push(boxSep(th, iW));
		lines.push(boxRow(th, th.fg("muted", "↑↓ navigate · enter select · ESC back"), iW));
		lines.push(boxBot(th, iW));
		return lines;
	}
}

// ── Overlay 3: Tool list ─────────────────────────────────────

class McpToolListOverlay {
	private tui: TUI;
	private theme: Theme;
	private onClose: () => void;
	private serverName: string;
	private tools: DiscoveredTool[];
	private isToolDisabled: (toolName: string) => boolean;
	private onToggleTool: (toolName: string) => void;
	private sel = 0;
	private scroll = 0;
	private maxVisible = 15;

	constructor(
		tui: TUI,
		theme: Theme,
		onClose: () => void,
		serverName: string,
		tools: DiscoveredTool[],
		isToolDisabled: (toolName: string) => boolean,
		onToggleTool: (toolName: string) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.serverName = serverName;
		this.tools = tools;
		this.isToolDisabled = isToolDisabled;
		this.onToggleTool = onToggleTool;
	}

	private ensureSelectionVisible(): void {
		if (this.sel < this.scroll) {
			this.scroll = this.sel;
			return;
		}
		if (this.sel >= this.scroll + this.maxVisible) {
			this.scroll = this.sel - this.maxVisible + 1;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.onClose();
			return;
		}

		if (this.tools.length === 0) return;

		if (matchesKey(data, "up") || data === "k") {
			this.sel = Math.max(0, this.sel - 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down") || data === "j") {
			this.sel = Math.min(this.tools.length - 1, this.sel + 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "return") || data === " ") {
			const tool = this.tools[this.sel];
			if (!tool) return;
			this.onToggleTool(tool.name);
			this.tui.requestRender();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const iW = Math.max(1, width - 2);
		const lines: string[] = [];
		const enabledCount = this.tools.filter((tool) => !this.isToolDisabled(tool.name)).length;

		lines.push(boxTop(th, `${this.serverName} · Tools`, iW));
		lines.push(boxRow(th, th.fg("muted", `Enabled ${enabledCount}/${this.tools.length}`), iW));
		lines.push(boxSep(th, iW));

		if (this.tools.length === 0) {
			lines.push(boxRow(th, th.fg("muted", "No tools available"), iW));
		} else {
			const from = this.scroll;
			const to = Math.min(this.tools.length, this.scroll + this.maxVisible);
			for (let i = from; i < to; i++) {
				const tool = this.tools[i];
				if (!tool) continue;
				const selected = i === this.sel;
				const cursor = selected ? th.fg("accent", "▸") : " ";
				const piName = buildPiToolName(this.serverName, tool.name);
				const name = selected ? th.fg("accent", th.bold(piName)) : piName;
				const enabled = !this.isToolDisabled(tool.name);
				const state = enabled ? th.fg("success", "● on") : th.fg("muted", "○ off");
				const desc = tool.description ? ` ${th.fg("muted", `— ${tool.description}`)}` : "";
				lines.push(boxRow(th, `${cursor} ${state} ${name}${desc}`, iW));
			}
			if (this.tools.length > this.maxVisible) {
				lines.push(boxSep(th, iW));
				const info = `${from + 1}–${to} of ${this.tools.length}`;
				lines.push(boxRow(th, th.fg("muted", info), iW));
			}
		}

		lines.push(boxSep(th, iW));
		lines.push(boxRow(th, th.fg("muted", "↑↓ navigate · Enter/Space toggle · ESC back"), iW));
		lines.push(boxBot(th, iW));
		return lines;
	}
}

type BridgeRuntime = {
	startBackgroundConnect: (cwd: string) => Promise<void>;
	shutdown: () => Promise<void>;
};

// Node caches extension modules, while Pi creates an extension instance for every session.
// Keep lifecycle state in the factory closure: shutting down a newly-created session must never
// dispose MCP connections still owned by another live Pi session in the same host process.
let latestRuntime: BridgeRuntime | null = null;

export function startBackgroundConnect(cwd: string): Promise<void> {
	return latestRuntime?.startBackgroundConnect(cwd) ?? Promise.resolve();
}

export default async function claudeMcpBridge(pi: ExtensionAPI) {
	const cwd = process.cwd();
	let latestContext: ExtensionContext | null = null;

	let runtimeReady = false;
	let backgroundPromise: Promise<void> | null = null;
	let shutdownPromise: Promise<void> | null = null;
	let cacheWritePromise: Promise<void> = Promise.resolve();
	const runtimeAbort = new AbortController();
	const registeredToolSchemas = new Map<string, string>();
	const bridgeDeactivatedTools = new Set<string>();
	let lastPersistedLiveState: string | null = null;
	const loadedToolVisibility = loadToolVisibilitySettings();
	const disabledToolKeys = loadedToolVisibility.disabledToolKeys;
	let toolVisibilityWarning = loadedToolVisibility.warning;
	const loadedAt = loadConfig(cwd);
	const configFingerprint = buildConfigFingerprint(loadedAt.servers);
	let loadedCache = loadMcpToolCache(configFingerprint);

	const manager = new McpManager(() => {
		if (!runtimeReady || !isCurrentRuntime()) return;
		registerDiscoveredTools();
		removeUnavailableToolsFromActiveSet();
		removeDisabledToolsFromActiveSet();
		persistLiveToolsIfChanged();
		if (latestContext) updateStatus(latestContext);
	});
	manager.configureServers(loadedAt.servers, loadedAt.sourcePath);
	if (loadedCache) manager.primeCachedTools(loadedCache.servers);

	function isCurrentRuntime(): boolean {
		return !runtimeAbort.signal.aborted;
	}

	function getOverlayWarnings(): string[] {
		const warnings = [...loadedAt.warnings];
		if (toolVisibilityWarning) warnings.push(toolVisibilityWarning);
		return warnings;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const states = manager.getStates();
		const total = states.length;
		if (total === 0) {
			ctx.ui.setStatus("mcp", undefined);
			return;
		}

		const connected = states.filter((state) => state.status === "connected").length;
		const failed = states.filter((state) => state.status === "error").length;
		const connecting = states.some((state) => state.status === "connecting");
		if (isOfflineMode()) {
			const cached = states.some((state) => state.cached && state.toolCount > 0);
			ctx.ui.setStatus("mcp", cached ? "MCP offline · cached" : "MCP offline");
			return;
		}
		if (connecting) {
			ctx.ui.setStatus("mcp", `MCP ${connected}/${total} connecting`);
			return;
		}
		ctx.ui.setStatus("mcp", failed > 0 ? `MCP ${connected}/${total} · ${failed} failed` : `MCP ${connected}/${total}`);
	}

	function isToolDisabled(serverName: string, toolName: string): boolean {
		return disabledToolKeys.has(buildToolVisibilityKey(serverName, toolName));
	}

	function getActiveToolSet(): Set<string> | null {
		try {
			return new Set(pi.getActiveTools());
		} catch {
			return null;
		}
	}

	function updateActiveToolSet(activeTools: Set<string>, changed: boolean): void {
		if (changed) pi.setActiveTools(Array.from(activeTools));
	}

	function removeDisabledToolsFromActiveSet(): void {
		const activeTools = getActiveToolSet();
		if (!activeTools) return;
		let changed = false;
		for (const { serverName, tool } of manager.getAllTools()) {
			if (!isToolDisabled(serverName, tool.name)) continue;
			if (activeTools.delete(buildPiToolName(serverName, tool.name))) changed = true;
		}
		updateActiveToolSet(activeTools, changed);
	}

	function removeUnavailableToolsFromActiveSet(): void {
		const activeTools = getActiveToolSet();
		if (!activeTools) return;
		const available = new Set(
			manager.getAllTools().map(({ serverName, tool }) => buildPiToolName(serverName, tool.name)),
		);
		let changed = false;
		for (const toolName of registeredToolSchemas.keys()) {
			if (!available.has(toolName) && activeTools.delete(toolName)) {
				bridgeDeactivatedTools.add(toolName);
				changed = true;
			}
		}
		updateActiveToolSet(activeTools, changed);
	}

	function setToolActive(piToolName: string, enabled: boolean): void {
		const activeTools = getActiveToolSet();
		if (!activeTools) return;
		const changed = enabled ? !activeTools.has(piToolName) : activeTools.has(piToolName);
		if (enabled) activeTools.add(piToolName);
		else activeTools.delete(piToolName);
		updateActiveToolSet(activeTools, changed);
	}

	function toggleToolDisabled(
		serverName: string,
		toolName: string,
	): { ok: true; disabled: boolean } | { ok: false; error: string } {
		const key = buildToolVisibilityKey(serverName, toolName);
		const currentlyDisabled = disabledToolKeys.has(key);
		const nextDisabled = !currentlyDisabled;
		if (nextDisabled) disabledToolKeys.add(key);
		else disabledToolKeys.delete(key);

		const saved = saveToolVisibilitySettings(disabledToolKeys);
		if (!saved.ok) {
			if (currentlyDisabled) disabledToolKeys.add(key);
			else disabledToolKeys.delete(key);
			return { ok: false, error: saved.error };
		}

		toolVisibilityWarning = undefined;
		return { ok: true, disabled: nextDisabled };
	}

	function notifyStatusSummary(ctx: ExtensionContext): void {
		const states = manager.getStates();
		const summary = states
			.map((state) => {
				const tools = state.toolCount > 0 ? `(${state.toolCount}${state.cached ? ",cached" : ""})` : "";
				const error = state.error ? `:${state.error}` : "";
				return `${state.name}=${state.status}${tools}${error}`;
			})
			.join(", ");
		const sourceText = manager.sourcePath ? ` | source: ${manager.sourcePath}` : "";
		const disabledCount = manager
			.getAllTools()
			.filter(({ serverName, tool }) => isToolDisabled(serverName, tool.name)).length;
		const disabledText = disabledCount > 0 ? ` | disabled tools: ${disabledCount}` : "";
		ctx.ui.notify(`MCP: ${summary}${sourceText}${disabledText}`, "info");
	}

	function handleToolToggle(
		ctx: ExtensionContext,
		serverName: string,
		toolName: string,
		setReloadNeeded: (value: boolean) => void,
	): void {
		const toggled = toggleToolDisabled(serverName, toolName);
		if (!toggled.ok) {
			ctx.ui.notify(`Failed to save MCP tool settings: ${toggled.error}`, "warning");
			return;
		}

		registerDiscoveredTools();
		removeDisabledToolsFromActiveSet();
		const piToolName = buildPiToolName(serverName, toolName);
		if (toggled.disabled) {
			if (registeredToolSchemas.has(piToolName)) setReloadNeeded(true);
			setToolActive(piToolName, false);
			ctx.ui.notify(`${piToolName}: disabled`, "info");
			return;
		}

		if (registeredToolSchemas.has(piToolName)) {
			setToolActive(piToolName, true);
			ctx.ui.notify(`${piToolName}: enabled`, "info");
			return;
		}
		ctx.ui.notify(`${piToolName}: enabled (connect or reload to register)`, "warning");
	}

	async function showToolOverlay(
		ctx: ExtensionContext,
		serverName: string,
		setReloadNeeded: (value: boolean) => void,
	): Promise<void> {
		const tools = manager.getServerTools(serverName);
		await ctx.ui.custom<null>(
			(tui, theme, _kb, done) =>
				new McpToolListOverlay(
					tui,
					theme,
					() => done(null),
					serverName,
					tools,
					(toolName) => isToolDisabled(serverName, toolName),
					(toolName) => handleToolToggle(ctx, serverName, toolName, setReloadNeeded),
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%" } },
		);
	}

	async function reconnectSelectedServer(ctx: ExtensionContext, serverName: string): Promise<void> {
		try {
			await manager.reconnectServer(serverName, { signal: runtimeAbort.signal });
		} catch (error) {
			ctx.ui.notify(`${serverName}: ${errorMessage(error)}`, "warning");
			updateStatus(ctx);
			return;
		}
		registerDiscoveredTools();
		removeUnavailableToolsFromActiveSet();
		removeDisabledToolsFromActiveSet();
		updateStatus(ctx);
		const updated = manager.getStates().find((state) => state.name === serverName);
		if (updated?.status === "connected") {
			ctx.ui.notify(`${serverName}: reconnected (${updated.toolCount} tools)`, "info");
			return;
		}
		ctx.ui.notify(
			`${serverName}: ${updated?.status ?? "unknown"}${updated?.error ? ` – ${updated.error}` : ""}`,
			"warning",
		);
	}

	async function openMcpStatusOverlay(ctx: ReloadableContext, disabledAtCommandStart: Set<string>): Promise<void> {
		let shouldReloadForVisibility = false;
		const setReloadNeeded = (value: boolean) => {
			if (value) shouldReloadForVisibility = true;
		};

		serverList: while (true) {
			const freshStates = manager.getStates();
			const serverName = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) =>
					new McpStatusOverlay(tui, theme, done, freshStates, manager.sourcePath, getOverlayWarnings()),
				{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%" } },
			);
			if (!serverName) break;

			while (true) {
				const serverState = manager.getStates().find((state) => state.name === serverName);
				if (!serverState) break;
				const action = await ctx.ui.custom<ServerAction | null>(
					(tui, theme, _kb, done) => new McpActionOverlay(tui, theme, done, serverState),
					{ overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 50, maxHeight: "80%" } },
				);
				if (action === "tools") {
					await showToolOverlay(ctx, serverName, setReloadNeeded);
					continue;
				}
				if (action === "reconnect") {
					await reconnectSelectedServer(ctx, serverName);
					continue serverList;
				}
				continue serverList;
			}
		}

		if (shouldReloadForVisibility || hasNewlyDisabledTools(disabledAtCommandStart, disabledToolKeys)) {
			ctx.ui.notify("Reloading runtime to hide disabled MCP tools...", "info");
			await ctx.reload();
		}
	}

	function registerDiscoveredTools(): void {
		if (!isCurrentRuntime()) return;
		for (const { serverName, tool } of manager.getAllTools()) {
			if (isToolDisabled(serverName, tool.name)) continue;
			const piToolName = buildPiToolName(serverName, tool.name);
			const schemaFingerprint = stableStringify({ description: tool.description, inputSchema: tool.inputSchema });
			const reactivate = bridgeDeactivatedTools.delete(piToolName);
			if (registeredToolSchemas.get(piToolName) === schemaFingerprint) {
				if (reactivate) setToolActive(piToolName, true);
				continue;
			}

			pi.registerTool({
				name: piToolName,
				label: `MCP ${serverName}/${tool.name}`,
				description: tool.description ?? `MCP tool ${serverName}/${tool.name}`,
				parameters: createParameterSchema(tool.inputSchema),

				renderCall(args, theme) {
					return renderMcpToolCall(serverName, tool.name, args, theme);
				},

				renderResult(result, { expanded }, theme) {
					const tc = result.content.find((content) => content.type === "text");
					if (!expanded) {
						if (tc?.type === "text") {
							const count = tc.text.trim().split("\n").filter(Boolean).length;
							if (count > 0) return new Text(theme.fg("muted", ` → ${count} lines`), 0, 0);
						}
						return new Text("", 0, 0);
					}
					if (tc?.type !== "text") return new Text("", 0, 0);
					const output = tc.text
						.trim()
						.split("\n")
						.map((line) => theme.fg("toolOutput", line))
						.join("\n");
					return output ? new Text(`\n${output}`, 0, 0) : new Text("", 0, 0);
				},

				async execute(_toolCallId, params, signal, onUpdate, _ctx) {
					const connecting = manager.getStatus(serverName) !== "connected";
					onUpdate?.({
						content: [
							{
								type: "text" as const,
								text: connecting
									? `Connecting to MCP server '${serverName}'...`
									: `Calling MCP ${serverName}/${tool.name}...`,
							},
						],
						details: { server: serverName, tool: tool.name, status: connecting ? "connecting" : "running" },
					});
					return executeMcpToolCall({
						manager,
						serverName,
						tool,
						params: params as Record<string, unknown>,
						signal,
						isToolDisabled,
					});
				},
			});

			registeredToolSchemas.set(piToolName, schemaFingerprint);
			if (reactivate) setToolActive(piToolName, true);
		}
	}

	function liveToolStateFingerprint(): string | null {
		const connectedStates = manager.getStates().filter((state) => state.status === "connected");
		if (connectedStates.length === 0) return null;
		return stableStringify(
			connectedStates.map((state) => ({ name: state.name, tools: manager.getServerTools(state.name) })),
		);
	}

	function createToolCacheSnapshot(): McpToolCache {
		const now = new Date().toISOString();
		const servers: McpToolCache["servers"] = {};
		for (const state of manager.getStates()) {
			if (state.status === "connected") {
				servers[state.name] = { updatedAt: now, tools: manager.getServerTools(state.name) };
				continue;
			}
			const cached = loadedCache?.servers[state.name];
			if (cached) servers[state.name] = cached;
		}
		return { version: 1, configFingerprint, servers };
	}

	function persistLiveToolsIfChanged(): void {
		const liveState = liveToolStateFingerprint();
		if (!liveState || liveState === lastPersistedLiveState) return;
		const snapshot = createToolCacheSnapshot();
		cacheWritePromise = cacheWritePromise.then(async () => {
			if (liveState === lastPersistedLiveState) return;
			try {
				loadedCache = await mergeAndSaveMcpToolCache(snapshot);
				lastPersistedLiveState = liveState;
			} catch (error) {
				const warning = `Failed to save MCP tool cache: ${errorMessage(error)}`;
				if (!loadedAt.warnings.includes(warning)) loadedAt.warnings.push(warning);
			}
		});
	}

	function startRuntimeBackgroundConnect(_cwd: string): Promise<void> {
		if (backgroundPromise) return backgroundPromise;
		const promise = (async () => {
			if (!isCurrentRuntime() || isOfflineMode()) {
				if (latestContext) updateStatus(latestContext);
				return;
			}
			await manager.connectAll({ signal: runtimeAbort.signal });
			if (!isCurrentRuntime()) return;
			registerDiscoveredTools();
			removeUnavailableToolsFromActiveSet();
			removeDisabledToolsFromActiveSet();
			persistLiveToolsIfChanged();
			if (latestContext) updateStatus(latestContext);
		})().catch((error) => {
			if (!isCurrentRuntime()) return;
			const warning = `Background MCP connection failed: ${errorMessage(error)}`;
			if (!loadedAt.warnings.includes(warning)) loadedAt.warnings.push(warning);
			if (latestContext) updateStatus(latestContext);
		});
		backgroundPromise = promise;
		return promise;
	}

	function shutdownRuntime(): Promise<void> {
		if (shutdownPromise) return shutdownPromise;
		runtimeAbort.abort(new Error("MCP runtime shut down"));
		shutdownPromise = (async () => {
			await cacheWritePromise;
			await manager.dispose();
		})();
		return shutdownPromise;
	}

	const runtime: BridgeRuntime = {
		startBackgroundConnect: startRuntimeBackgroundConnect,
		shutdown: shutdownRuntime,
	};
	latestRuntime = runtime;
	runtimeReady = true;

	registerDiscoveredTools();
	removeDisabledToolsFromActiveSet();

	pi.on("session_start", async (_event, ctx) => {
		if (!isCurrentRuntime()) return;
		latestContext = ctx;
		if (process.env.PI_MCP_EAGER !== "1") void startRuntimeBackgroundConnect(ctx.cwd);
		updateStatus(ctx);
		removeUnavailableToolsFromActiveSet();
		removeDisabledToolsFromActiveSet();
		if (toolVisibilityWarning && ctx.hasUI) {
			ctx.ui.notify(`[claude-mcp-bridge] ${toolVisibilityWarning}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		if (latestRuntime === runtime) latestRuntime = null;
		latestContext = null;
		await shutdownRuntime();
	});

	pi.registerCommand("mcp-status", {
		description: "Show MCP server connection status",
		handler: async (_args, ctx) => {
			if (manager.getStates().length === 0) {
				ctx.ui.notify("MCP: no configured servers", "warning");
				return;
			}

			const disabledAtCommandStart = new Set(disabledToolKeys);
			if (!ctx.hasUI) {
				notifyStatusSummary(ctx);
				return;
			}
			await openMcpStatusOverlay(ctx as ReloadableContext, disabledAtCommandStart);
		},
	});

	if (process.env.PI_MCP_EAGER === "1") await startRuntimeBackgroundConnect(cwd);
}
