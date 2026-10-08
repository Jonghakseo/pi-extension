/**
 * Event-based waits for the PoC. Nothing here polls a tool; it watches the files the child writes
 * and resolves on the first matching content.
 *
 * Not part of the published package.
 */
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";

export interface Marker {
	kind?: string;
	verb?: string;
	args?: string[];
	model?: string;
	text?: string;
	toolResult?: { name?: string; isError?: boolean; text?: string };
}

/** fs.watch can coalesce or miss an append on macOS, so a slow re-read backs it up. */
const RECHECK_MS = 150;

export async function waitForFile(
	file: string,
	matches: (text: string) => boolean,
	timeoutMs = 30_000,
): Promise<string> {
	const read = async (): Promise<string> => {
		try {
			return await readFile(file, "utf8");
		} catch {
			return "";
		}
	};
	const current = await read();
	if (matches(current)) return current;
	return new Promise<string>((resolve, reject) => {
		let done = false;
		const finish = (error: Error | undefined, value?: string) => {
			if (done) return;
			done = true;
			clearInterval(recheck);
			clearTimeout(timer);
			watcher?.close();
			if (error) reject(error);
			else resolve(value ?? "");
		};
		const check = () => {
			void read().then((text) => {
				if (matches(text)) finish(undefined, text);
			});
		};
		const recheck = setInterval(check, RECHECK_MS);
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${file}`)), timeoutMs);
		let watcher: ReturnType<typeof watch> | undefined;
		try {
			watcher = watch(file, check);
		} catch {
			// The file may not exist yet; the interval still picks it up.
		}
		check();
	});
}

export function parseMarkers(text: string): Marker[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return JSON.parse(line) as Marker;
			} catch {
				return {} as Marker;
			}
		});
}

export async function waitForMarker(
	file: string,
	matches: (marker: Marker) => boolean,
	timeoutMs = 30_000,
): Promise<Marker> {
	const text = await waitForFile(file, (content) => parseMarkers(content).some(matches), timeoutMs);
	const found = parseMarkers(text).find(matches);
	if (!found) throw new Error(`Marker vanished from ${file}`);
	return found;
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		return false;
	}
}
