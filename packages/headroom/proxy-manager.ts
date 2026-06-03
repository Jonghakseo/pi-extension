import { execFile, spawn } from "node:child_process";
import type { HeadroomConfig } from "./types.ts";

export interface ProxyEndpoint {
	host: string;
	port: string;
}

export async function startPersistentHeadroomProxy(
	config: HeadroomConfig,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const endpoint = parseLocalEndpoint(config.baseUrl);
	if (!endpoint) return { ok: false, reason: "unsupported-local-url" };

	const available = await isCommandAvailable(config.command);
	if (!available) return { ok: false, reason: `command-not-found:${config.command}` };

	try {
		const child = spawn(config.command, buildProxyArgs(endpoint), {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				HEADROOM_TELEMETRY: process.env.HEADROOM_TELEMETRY || "off",
			},
		});
		child.unref();
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

export function buildProxyArgs(endpoint: ProxyEndpoint): string[] {
	return ["proxy", "--host", endpoint.host, "--port", endpoint.port, "--mode", "token", "--no-cache"];
}

export function parseLocalEndpoint(baseUrl: string): ProxyEndpoint | undefined {
	try {
		const url = new URL(baseUrl);
		if (!["http:", "https:"].includes(url.protocol)) return undefined;
		if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return undefined;
		const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[(.*)]$/, "$1");
		const port = url.port || "8787";
		return { host, port };
	} catch {
		return undefined;
	}
}

function isCommandAvailable(command: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = execFile(command, ["--help"], { timeout: 1500 }, (error) => {
			resolve(!error);
		});
		child.on("error", () => resolve(false));
	});
}
