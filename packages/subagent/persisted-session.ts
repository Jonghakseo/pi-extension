/** biome-ignore-all lint/suspicious/noExplicitAny: persisted JSONL entries are dynamic runtime data. */
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";

export interface CompletionMarker {
	exitCode: number;
	stopReason?: string;
	runtime?: string;
	timestamp?: number;
}

export interface PersistedSessionReadOptions {
	startOffset?: number;
}

export interface PersistedSessionSnapshot {
	messages: Message[];
	latestActivityAt?: number;
	finalOutput: string;
	terminalStopReason?: string;
	completionMarker?: CompletionMarker;
	isTerminal: boolean;
}

export interface DisplayTaskUpdateEntry {
	runId: number;
	task: string;
	displayTask: string;
	startedAt: number;
	updatedAt?: number;
}

function parseTimestamp(raw: unknown): number | undefined {
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}

function extractFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text" && part.text) return part.text;
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "thinking" && part.thinking) return part.thinking;
		}
	}
	return "";
}

export function getSessionFileMtimeMs(sessionFile?: string): number | undefined {
	if (!sessionFile) return undefined;
	try {
		return fs.statSync(sessionFile).mtimeMs;
	} catch {
		return undefined;
	}
}

export function getSessionFileSize(sessionFile?: string): number {
	if (!sessionFile) return 0;
	try {
		return fs.statSync(sessionFile).size;
	} catch {
		return 0;
	}
}

export function appendCompletionMarker(sessionFile: string | undefined, marker: CompletionMarker): void {
	if (!sessionFile) return;
	const entry = {
		type: "subagent_done",
		timestamp: marker.timestamp ?? Date.now(),
		exitCode: marker.exitCode,
		stopReason: marker.stopReason,
		runtime: marker.runtime,
	};
	try {
		fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// best effort only
	}
}

export function appendDisplayTaskUpdate(sessionFile: string | undefined, update: DisplayTaskUpdateEntry): void {
	if (!sessionFile) return;
	const timestamp = new Date(update.updatedAt ?? Date.now()).toISOString();
	const entry = {
		type: "custom",
		customType: "subagent-display-task",
		data: {
			runId: update.runId,
			task: update.task,
			displayTask: update.displayTask,
			startedAt: update.startedAt,
			updatedAt: update.updatedAt ?? Date.now(),
		},
		id: `subagent-display-task-${update.runId}-${Math.random().toString(16).slice(2, 10)}`,
		timestamp,
	};
	try {
		fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		// best effort only
	}
}

export function readPersistedSessionSnapshot(
	sessionFile?: string,
	options: PersistedSessionReadOptions = {},
): PersistedSessionSnapshot {
	if (!sessionFile || !fs.existsSync(sessionFile)) {
		return { messages: [], finalOutput: "", isTerminal: false };
	}

	let raw = "";
	try {
		const buffer = fs.readFileSync(sessionFile);
		const startOffset = Math.max(0, Math.min(options.startOffset ?? 0, buffer.length));
		raw = buffer.subarray(startOffset).toString("utf8");
	} catch {
		return { messages: [], finalOutput: "", isTerminal: false };
	}

	const messages: Message[] = [];
	let latestActivityAt: number | undefined;
	let terminalStopReason: string | undefined;
	let completionMarker: CompletionMarker | undefined;

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;

		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry?.type === "subagent_done") {
			const markerTs = parseTimestamp(entry.timestamp);
			if (markerTs && (latestActivityAt == null || markerTs > latestActivityAt)) latestActivityAt = markerTs;
			completionMarker = {
				exitCode: typeof entry.exitCode === "number" ? entry.exitCode : 0,
				stopReason: typeof entry.stopReason === "string" ? entry.stopReason : undefined,
				runtime: typeof entry.runtime === "string" ? entry.runtime : undefined,
				timestamp: markerTs,
			};
			continue;
		}

		if (entry?.type !== "message" || !entry.message) continue;
		const message = entry.message as Message & { stopReason?: string; timestamp?: string | number };
		const role = (message as any).role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
		messages.push(message);

		const ts = parseTimestamp((message as any).timestamp ?? entry.timestamp);
		if (ts && (latestActivityAt == null || ts > latestActivityAt)) latestActivityAt = ts;

		if (role === "assistant") {
			const stopReason = typeof (message as any).stopReason === "string" ? (message as any).stopReason : undefined;
			if (stopReason && stopReason !== "toolUse") terminalStopReason = stopReason;
		}
	}

	const finalOutput = extractFinalOutput(messages);
	return {
		messages,
		latestActivityAt,
		finalOutput,
		terminalStopReason,
		completionMarker,
		isTerminal: !!completionMarker || !!terminalStopReason,
	};
}
