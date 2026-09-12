import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { memoryEntryId, type SearchResult } from "./storage.ts";
import type { MemoryTier } from "./types.ts";

const ENTRY_TYPE = "memory-layer-agent";
const DELETE_ENTRY_TYPE = "memory-layer-agent-delete";
const SCHEMA_VERSION = 1;

type AgentMemoryPayload = {
	schemaVersion: number;
	ownerSessionId: string;
	topic: string;
	title: string;
	content: string;
	tier: MemoryTier;
};

type AgentMemoryDeletePayload = {
	schemaVersion: number;
	ownerSessionId: string;
	id: string;
};

function sessionId(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId();
	if (!id) throw new Error("agent scope requires an active Pi session");
	return id;
}

function isTier(value: unknown): value is MemoryTier {
	return value === "profile" || value === "log" || value === "note";
}

function isAgentMemoryPayload(value: unknown): value is AgentMemoryPayload {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return (
		data.schemaVersion === SCHEMA_VERSION &&
		typeof data.ownerSessionId === "string" &&
		typeof data.topic === "string" &&
		typeof data.title === "string" &&
		typeof data.content === "string" &&
		isTier(data.tier)
	);
}

function isAgentMemoryDeletePayload(value: unknown): value is AgentMemoryDeletePayload {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return (
		data.schemaVersion === SCHEMA_VERSION && typeof data.ownerSessionId === "string" && typeof data.id === "string"
	);
}

/**
 * Restore this session's agent-scoped memories from custom session entries.
 * ownerSessionId keeps entries copied into a fork invisible to that fork.
 */
export function loadAgentMemories(ctx: ExtensionContext): SearchResult[] {
	const ownerSessionId = sessionId(ctx);
	const entries = new Map<string, SearchResult>();

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom") continue;
		if (
			entry.customType === ENTRY_TYPE &&
			isAgentMemoryPayload(entry.data) &&
			entry.data.ownerSessionId === ownerSessionId
		) {
			const memory: SearchResult = {
				scope: "agent",
				projectId: ownerSessionId,
				topic: entry.data.topic,
				title: entry.data.title,
				content: entry.data.content,
				tier: entry.data.tier,
			};
			entries.set(memoryEntryId(memory.scope, memory.projectId, memory.topic, memory.title, memory.content), memory);
		}
		if (
			entry.customType === DELETE_ENTRY_TYPE &&
			isAgentMemoryDeletePayload(entry.data) &&
			entry.data.ownerSessionId === ownerSessionId
		) {
			entries.delete(entry.data.id);
		}
	}

	return [...entries.values()];
}

export function saveAgentMemory(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: ExtensionContext,
	memory: Omit<SearchResult, "scope" | "projectId"> & { tier: MemoryTier },
): SearchResult {
	const ownerSessionId = sessionId(ctx);
	const result: SearchResult = { ...memory, scope: "agent", projectId: ownerSessionId };
	pi.appendEntry<AgentMemoryPayload>(ENTRY_TYPE, {
		schemaVersion: SCHEMA_VERSION,
		ownerSessionId,
		topic: result.topic,
		title: result.title,
		content: result.content,
		tier: result.tier,
	});
	return result;
}

export function removeAgentMemory(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: ExtensionContext,
	memory: SearchResult,
): void {
	const ownerSessionId = sessionId(ctx);
	if (memory.scope !== "agent" || memory.projectId !== ownerSessionId) {
		throw new Error("agent memory does not belong to the current session");
	}
	pi.appendEntry<AgentMemoryDeletePayload>(DELETE_ENTRY_TYPE, {
		schemaVersion: SCHEMA_VERSION,
		ownerSessionId,
		id: memoryEntryId(memory.scope, memory.projectId, memory.topic, memory.title, memory.content),
	});
}
