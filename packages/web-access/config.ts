/**
 * Shared configuration loader for web-access extensions.
 *
 * All config files under `~/.pi/web-search.json` share the same pattern:
 *   1. Check a module-level cache
 *   2. If missing, read & parse `~/.pi/web-search.json`
 *   3. Return a typed subset of the parsed JSON
 *
 * This module centralises that logic so each provider only specifies
 * its own key, default values, and normalisers.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
let activeConfigPath = CONFIG_PATH;

/** Raw JSON shape of `~/.pi/web-search.json` (all keys optional). */
export interface WebSearchConfig {
	exaApiKey?: unknown;
	video?: { enabled?: unknown; maxSizeMB?: unknown };
	githubClone?: {
		enabled?: unknown;
	};
}

// ─── Generic config loader ──────────────────────────────────────────────────

type ConfigNormaliser<T> = (raw: WebSearchConfig) => T;

const configCache = new Map<string, unknown>();

/**
 * Read, parse, and cache `~/.pi/web-search.json`.
 *
 * @param key      Unique cache key (e.g. `"exa"`, `"video"`)
 * @param defaults Fallback values when the file or key is missing
 * @param normalise  Transform the raw parsed JSON into the desired shape
 */
export function loadConfigSection<T>(key: string, defaults: T, normalise: ConfigNormaliser<T>): T {
	const cached = configCache.get(key);
	if (cached !== undefined) return cached as T;

	if (!existsSync(activeConfigPath)) {
		configCache.set(key, defaults);
		return defaults;
	}

	const rawText = readFileSync(activeConfigPath, "utf-8");
	let raw: WebSearchConfig;
	try {
		raw = JSON.parse(rawText) as WebSearchConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${activeConfigPath}: ${message}`);
	}

	const result = normalise(raw);
	configCache.set(key, result);
	return result;
}

/**
 * Invalidate a cached config section (or all sections).
 * Useful when a provider writes its own config and needs a fresh read.
 */
export function setConfigPathForTests(path: string | null): void {
	activeConfigPath = path ?? CONFIG_PATH;
	invalidateConfig();
}

export function invalidateConfig(key?: string): void {
	if (key) {
		configCache.delete(key);
	} else {
		configCache.clear();
	}
}

// ─── Shared normaliser helpers ──────────────────────────────────────────────

/** Trim a string; return `null` if empty or not a string. */
export function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

/** Coerce an unknown to `boolean`, falling back to `fallback`. */
export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** Coerce an unknown to a trimmed string; return `fallback` if empty/non-string. */
export function normalizeString(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}

/** Coerce an unknown to a positive finite number; return `fallback` otherwise. */
export function normalizePositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value > 0 ? value : fallback;
}
