import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HeadroomConfig } from "./types.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:8788";
const DEFAULT_MIN_CONTEXT_TOKENS = 20_000;
const DEFAULT_MIN_MESSAGE_CHARS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export const HEADROOM_SETTINGS_DIR = path.join(os.homedir(), ".pi", "agent", "headroom");
export const HEADROOM_SETTINGS_FILE = path.join(HEADROOM_SETTINGS_DIR, "settings.json");

export interface HeadroomSettings {
	enabled?: boolean | string;
	baseUrl?: string;
	url?: string;
	allowRemote?: boolean | string;
	autoStart?: boolean | string;
	command?: string;
	minContextTokens?: number | string;
	minMessageChars?: number | string;
	timeoutMs?: number | string;
}

export function loadHeadroomSettings(settingsPath: string = HEADROOM_SETTINGS_FILE): HeadroomSettings {
	try {
		const raw = fs.readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as HeadroomSettings;
	} catch {
		// Missing or invalid settings.json falls back to env/defaults.
	}
	return {};
}

export function loadHeadroomConfig(
	env: NodeJS.ProcessEnv = process.env,
	settings: HeadroomSettings = env === process.env ? loadHeadroomSettings() : {},
): HeadroomConfig {
	const envBaseUrl = env.PI_HEADROOM_URL || env.HEADROOM_URL || env.HEADROOM_BASE_URL || DEFAULT_BASE_URL;
	const baseUrl = normalizeBaseUrl(parseString(settings.baseUrl ?? settings.url, envBaseUrl));
	return {
		enabled: parseBoolean(settings.enabled, parseBoolean(env.PI_HEADROOM_ENABLED, true)),
		baseUrl,
		allowRemote: parseBoolean(settings.allowRemote, parseBoolean(env.PI_HEADROOM_ALLOW_REMOTE, false)),
		autoStart: parseBoolean(settings.autoStart, parseBoolean(env.PI_HEADROOM_AUTO_START, true)),
		command: parseString(settings.command, env.PI_HEADROOM_COMMAND?.trim() || "headroom"),
		minContextTokens: parseInteger(
			settings.minContextTokens,
			parseInteger(env.PI_HEADROOM_MIN_CONTEXT_TOKENS, DEFAULT_MIN_CONTEXT_TOKENS, 0),
			0,
		),
		minMessageChars: parseInteger(
			settings.minMessageChars,
			parseInteger(env.PI_HEADROOM_MIN_MESSAGE_CHARS, DEFAULT_MIN_MESSAGE_CHARS, 1),
			1,
		),
		timeoutMs: parseInteger(settings.timeoutMs, parseInteger(env.PI_HEADROOM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100), 100),
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

function parseString(raw: unknown, fallback: string): string {
	if (typeof raw !== "string") return fallback;
	return raw.trim() || fallback;
}

function parseBoolean(raw: unknown, fallback: boolean): boolean {
	if (raw === undefined) return fallback;
	if (typeof raw === "boolean") return raw;
	if (typeof raw !== "string") return fallback;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function parseInteger(raw: unknown, fallback: number, min: number): number {
	if (raw === undefined) return fallback;
	const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed < min) return fallback;
	return Math.trunc(parsed);
}
