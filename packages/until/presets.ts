import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInterval } from "./time.ts";

export interface UntilPreset {
	name: string;
	defaultInterval: { ms: number; label: string };
	prompt: string;
	description: string;
}

function normalizeName(name: string): string {
	return name.trim().toUpperCase();
}

function splitFrontmatter(content: string): { meta: Record<string, string>; body: string } {
	const cleaned = content.replace(/^\uFEFF/, "");
	if (!/^---\r?\n/.test(cleaned)) return { meta: {}, body: cleaned.trim() };

	const match = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
	if (!match) throw new Error("frontmatter 닫는 구분자(---)가 없습니다.");

	const meta: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (key && value) meta[key] = value;
	}
	return { meta, body: match[2].trim() };
}

export function parsePreset(content: string, name: string): UntilPreset {
	const normalizedName = normalizeName(name);
	const { meta, body } = splitFrontmatter(content);
	if (!body) throw new Error(`프리셋 ${normalizedName}의 본문이 비어 있습니다.`);

	const defaultInterval = parseInterval(meta.interval ?? "5m");
	if (!defaultInterval) throw new Error(`프리셋 ${normalizedName}의 interval이 올바르지 않습니다.`);

	return {
		name: normalizedName,
		defaultInterval,
		prompt: body,
		description: meta.description ?? normalizedName,
	};
}

export async function loadPresets(dir: string): Promise<Record<string, UntilPreset>> {
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return {};
	}

	const presets: Record<string, UntilPreset> = {};
	for (const file of files.sort()) {
		if (!file.toLowerCase().endsWith(".md")) continue;
		const name = normalizeName(file.slice(0, -3));
		try {
			presets[name] = parsePreset(await readFile(join(dir, file), "utf8"), name);
		} catch {
			// Invalid presets stay invisible until the user addresses that exact file.
		}
	}
	return presets;
}

export function getPresetCompletions(dir: string, prefix: string): { value: string; label: string }[] | null {
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return null;
	}

	const normalizedPrefix = normalizeName(prefix);
	const items: { value: string; label: string }[] = [];
	for (const file of files.sort()) {
		if (!file.toLowerCase().endsWith(".md")) continue;
		const name = normalizeName(file.slice(0, -3));
		if (!name.startsWith(normalizedPrefix)) continue;
		try {
			const preset = parsePreset(readFileSync(join(dir, file), "utf8"), name);
			items.push({ value: name, label: `${name} - ${preset.description} (${preset.defaultInterval.label})` });
		} catch {
			// Autocomplete only advertises presets that the command can load.
		}
	}
	return items.length > 0 ? items : null;
}

export function presetFileExists(dir: string, name: string): boolean {
	const normalizedName = normalizeName(name);
	try {
		return readdirSync(dir).some(
			(file) => file.toLowerCase().endsWith(".md") && normalizeName(file.slice(0, -3)) === normalizedName,
		);
	} catch {
		return false;
	}
}
