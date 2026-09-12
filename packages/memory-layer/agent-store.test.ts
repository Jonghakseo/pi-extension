import { describe, expect, it, vi } from "vitest";
import { loadAgentMemories, removeAgentMemory, saveAgentMemory } from "./agent-store.ts";

function context(sessionId: string, entries: unknown[] = []) {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries,
		},
	} as never;
}

describe("agent session memory", () => {
	it("restores the owner session but isolates a different or forked session", () => {
		const appendEntry = vi.fn();
		const pi = { appendEntry } as never;
		const sessionA = context("session-a");
		const saved = saveAgentMemory(pi, sessionA, {
			topic: "general",
			title: "Current task",
			content: "Keep this only in session A",
			tier: "log",
		});
		const entry = { type: "custom", customType: "memory-layer-agent", data: appendEntry.mock.calls[0][1] };

		expect(loadAgentMemories(context("session-a", [entry]))).toEqual([saved]);
		expect(loadAgentMemories(context("session-b", [entry]))).toEqual([]);
	});

	it("replays same-session deletion without deleting fork-owned data", () => {
		const appendEntry = vi.fn();
		const pi = { appendEntry } as never;
		const sessionA = context("session-a");
		const saved = saveAgentMemory(pi, sessionA, {
			topic: "general",
			title: "Temporary",
			content: "remove me",
			tier: "note",
		});
		removeAgentMemory(pi, sessionA, saved);
		const entries = [
			{ type: "custom", customType: "memory-layer-agent", data: appendEntry.mock.calls[0][1] },
			{ type: "custom", customType: "memory-layer-agent-delete", data: appendEntry.mock.calls[1][1] },
		];

		expect(loadAgentMemories(context("session-a", entries))).toEqual([]);
		expect(loadAgentMemories(context("session-b", entries))).toEqual([]);
	});
});
