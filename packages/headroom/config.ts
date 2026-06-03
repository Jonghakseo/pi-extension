import type { HeadroomConfig } from "./types.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:8788";
const DEFAULT_MIN_CONTEXT_TOKENS = 20_000;
const DEFAULT_MIN_MESSAGE_CHARS = 2_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export function loadHeadroomConfig(env: NodeJS.ProcessEnv = process.env): HeadroomConfig {
	const baseUrl = normalizeBaseUrl(
		env.PI_HEADROOM_URL || env.HEADROOM_URL || env.HEADROOM_BASE_URL || DEFAULT_BASE_URL,
	);
	return {
		enabled: parseBoolean(env.PI_HEADROOM_ENABLED, true),
		baseUrl,
		allowRemote: parseBoolean(env.PI_HEADROOM_ALLOW_REMOTE, false),
		autoStart: parseBoolean(env.PI_HEADROOM_AUTO_START, true),
		command: env.PI_HEADROOM_COMMAND?.trim() || "headroom",
		minContextTokens: parseInteger(env.PI_HEADROOM_MIN_CONTEXT_TOKENS, DEFAULT_MIN_CONTEXT_TOKENS, 0),
		minMessageChars: parseInteger(env.PI_HEADROOM_MIN_MESSAGE_CHARS, DEFAULT_MIN_MESSAGE_CHARS, 1),
		timeoutMs: parseInteger(env.PI_HEADROOM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100),
	};
}

export function isLocalHeadroomUrl(rawUrl: string): boolean {
	try {
		const url = new URL(rawUrl);
		return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
	} catch {
		return false;
	}
}

export function isRemoteBlocked(config: Pick<HeadroomConfig, "baseUrl" | "allowRemote">): boolean {
	return !config.allowRemote && !isLocalHeadroomUrl(config.baseUrl);
}

function normalizeBaseUrl(raw: string): string {
	const trimmed = raw.trim() || DEFAULT_BASE_URL;
	return trimmed.replace(/\/+$/, "");
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined) return fallback;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function parseInteger(raw: string | undefined, fallback: number, min: number): number {
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < min) return fallback;
	return parsed;
}
