import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WEB_SEARCH_CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

export interface WebSearchConfig {
	shortcuts?: {
		activity?: string;
	};
}

export function loadConfig(): WebSearchConfig {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return {};
	const raw = readFileSync(WEB_SEARCH_CONFIG_PATH, "utf-8");
	try {
		return JSON.parse(raw) as WebSearchConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${message}`);
	}
}

export const DEFAULT_SHORTCUTS = { activity: "ctrl+shift+w" };

export function loadConfigForExtensionInit(): WebSearchConfig {
	try {
		return loadConfig();
	} catch (err) {
		const _message = err instanceof Error ? err.message : String(err);
		return {};
	}
}

export function normalizeQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}
