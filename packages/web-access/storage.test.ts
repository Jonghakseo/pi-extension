import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearResults,
	deleteResult,
	getAllResults,
	getResult,
	restoreFromSession,
	type StoredSearchData,
	storeResult,
} from "./storage.js";

function makeSearchData(id: string, timestamp = Date.now()): StoredSearchData {
	return {
		id,
		type: "search",
		timestamp,
		queries: [{ query: "q", answer: "a", results: [], error: null, provider: "exa" }],
	};
}

function makeContext(entries: unknown[]): ExtensionContext {
	return {
		sessionManager: {
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
}

describe("web-access storage", () => {
	afterEach(() => {
		vi.useRealTimers();
		clearResults();
	});

	it("stores, reads, lists, deletes, and clears results", () => {
		const first = makeSearchData("first");
		const second: StoredSearchData = {
			id: "second",
			type: "fetch",
			timestamp: Date.now(),
			urls: [{ url: "https://example.com", title: "Example", content: "Body", error: null }],
		};

		storeResult(first.id, first);
		storeResult(second.id, second);

		expect(getResult("first")).toBe(first);
		expect(getResult("missing")).toBeNull();
		expect(getAllResults()).toEqual([first, second]);
		expect(deleteResult("first")).toBe(true);
		expect(deleteResult("first")).toBe(false);
		expect(getAllResults()).toEqual([second]);

		clearResults();
		expect(getAllResults()).toEqual([]);
	});

	it("restores only valid, non-expired web search entries from the session", () => {
		vi.setSystemTime(new Date("2026-04-24T00:00:00Z"));
		const now = Date.now();
		const fresh = makeSearchData("fresh", now - 1_000);
		const expired = makeSearchData("expired", now - 61 * 60 * 1_000);
		const invalidShape = { id: "invalid", type: "search", timestamp: now };

		storeResult("stale-before-restore", makeSearchData("stale-before-restore", now));
		restoreFromSession(
			makeContext([
				{ type: "custom", customType: "web-search-results", data: fresh },
				{ type: "custom", customType: "web-search-results", data: expired },
				{ type: "custom", customType: "web-search-results", data: invalidShape },
				{ type: "custom", customType: "other", data: makeSearchData("other", now) },
			]),
		);

		expect(getAllResults()).toEqual([fresh]);
		expect(getResult("expired")).toBeNull();
		expect(getResult("invalid")).toBeNull();
		expect(getResult("stale-before-restore")).toBeNull();
	});
});
