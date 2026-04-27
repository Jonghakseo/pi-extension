import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { LOG_TAIL_LINES } from "./constants.js";

export async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	await rename(tmp, filePath);
}

export function isPidAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		return code === "EPERM";
	}
}

export function isoNow(): string {
	return new Date().toISOString();
}

export function elapsedMs(startedAt?: string, finishedAt?: string): number {
	if (!startedAt) return 0;
	const start = Date.parse(startedAt);
	if (!Number.isFinite(start)) return 0;
	const end = finishedAt ? Date.parse(finishedAt) : Date.now();
	return Math.max(0, end - start);
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function skipCsi(value: string, index: number): number {
	let next = index + 1;
	while (next < value.length) {
		const code = value.charCodeAt(next);
		next++;
		if (code >= 0x40 && code <= 0x7e) break;
	}
	return next;
}

function skipOsc(value: string, index: number): number {
	let next = index + 1;
	while (next < value.length) {
		if (value.charCodeAt(next) === 0x07) return next + 1;
		if (value.charCodeAt(next) === 0x1b && value[next + 1] === "\\") return next + 2;
		next++;
	}
	return next;
}

export function stripAnsi(value: string): string {
	let output = "";
	let index = 0;
	while (index < value.length) {
		if (value.charCodeAt(index) !== 0x1b) {
			output += value[index];
			index++;
			continue;
		}

		const marker = value[index + 1];
		if (marker === "[") {
			index = skipCsi(value, index + 1);
		} else if (marker === "]") {
			index = skipOsc(value, index + 1);
		} else {
			index++;
		}
	}
	return output;
}

export function readLastLogLine(logPath: string | undefined): string | undefined {
	if (!logPath) return undefined;
	let text = "";
	try {
		text = readFileSync(logPath, "utf-8");
	} catch {
		return undefined;
	}
	const lines = text
		.split(/\r?\n/)
		.map((line) => stripAnsi(line).trim())
		.filter((line) => line.length > 0);
	return lines.at(-1);
}

export function readLogTail(logPath: string | undefined, maxLines = LOG_TAIL_LINES): string[] {
	if (!logPath) return [];
	try {
		return readFileSync(logPath, "utf-8")
			.split(/\r?\n/)
			.map((line) => stripAnsi(line).trimEnd())
			.filter((line) => line.trim().length > 0)
			.slice(-maxLines);
	} catch {
		return [];
	}
}

export function getLogIdleMs(logPath: string | undefined, startedAt?: string): number {
	try {
		if (logPath) return Date.now() - statSync(logPath).mtimeMs;
	} catch {
		// Fall through to startedAt based idle duration.
	}
	return elapsedMs(startedAt);
}

export async function maybeUnlink(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch {
		// Ignore missing files and concurrent cleanup.
	}
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
