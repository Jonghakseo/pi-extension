/**
 * Durable storage for grouped batch/chain pending completion summaries.
 *
 * This intentionally covers only finished group summaries that still need to be
 * delivered back to the origin session. It does NOT attempt to resume in-flight
 * batch/chain orchestration after reload or process restart.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PendingCompletion } from "./types.js";

export type PendingGroupScope = "batch" | "chain";

export interface PersistedPendingGroupCompletion {
	scope: PendingGroupScope;
	groupId: string;
	originSessionFile: string;
	runIds: number[];
	pendingCompletion: PendingCompletion;
}

function getStateDir(): string {
	return path.join(getAgentDir(), "state");
}

function getPendingGroupsFile(): string {
	return path.join(getStateDir(), "subagent-pending-groups.json");
}

function ensureStateDir(): void {
	fs.mkdirSync(getStateDir(), { recursive: true });
}

function readPersistedEntries(): PersistedPendingGroupCompletion[] {
	try {
		if (!fs.existsSync(getPendingGroupsFile())) return [];
		const raw = fs.readFileSync(getPendingGroupsFile(), "utf-8");
		if (!raw.trim()) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is PersistedPendingGroupCompletion => {
			return Boolean(
				entry &&
					(entry.scope === "batch" || entry.scope === "chain") &&
					typeof entry.groupId === "string" &&
					typeof entry.originSessionFile === "string" &&
					Array.isArray(entry.runIds) &&
					entry.pendingCompletion &&
					typeof entry.pendingCompletion.createdAt === "number",
			);
		});
	} catch {
		return [];
	}
}

function writePersistedEntries(entries: PersistedPendingGroupCompletion[]): void {
	ensureStateDir();
	fs.writeFileSync(getPendingGroupsFile(), `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
}

export function upsertPendingGroupCompletion(entry: PersistedPendingGroupCompletion): void {
	const entries = readPersistedEntries().filter(
		(item) => !(item.scope === entry.scope && item.groupId === entry.groupId),
	);
	entries.push(entry);
	writePersistedEntries(entries);
}

export function clearPendingGroupCompletion(scope: PendingGroupScope, groupId: string): void {
	const entries = readPersistedEntries().filter((entry) => !(entry.scope === scope && entry.groupId === groupId));
	writePersistedEntries(entries);
}

export function consumePendingGroupCompletionsForSession(sessionFile: string): PersistedPendingGroupCompletion[] {
	const entries = readPersistedEntries();
	const matched = entries.filter((entry) => entry.originSessionFile === sessionFile);
	if (matched.length === 0) return [];
	const remaining = entries.filter((entry) => entry.originSessionFile !== sessionFile);
	writePersistedEntries(remaining);
	return matched;
}

export function evictStalePendingGroupCompletions(maxAgeMs: number): void {
	const now = Date.now();
	const entries = readPersistedEntries().filter((entry) => now - entry.pendingCompletion.createdAt <= maxAgeMs);
	writePersistedEntries(entries);
}
