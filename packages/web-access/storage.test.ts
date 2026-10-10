import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedContent } from "./extract.js";
import {
	clearResults,
	deleteResult,
	getAllResults,
	getResult,
	restoreFromSession,
	type StoredSearchData,
	storeFetchedContentResult,
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

describe("web-access fetched content cache", () => {
	let root: string;
	const previousRoot = process.env.PI_WEB_ACCESS_CACHE_ROOT;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "web-access-cache-"));
		process.env.PI_WEB_ACCESS_CACHE_ROOT = root;
	});

	afterEach(() => {
		vi.useRealTimers();
		clearResults();
		if (previousRoot === undefined) delete process.env.PI_WEB_ACCESS_CACHE_ROOT;
		else process.env.PI_WEB_ACCESS_CACHE_ROOT = previousRoot;
		rmSync(root, { recursive: true, force: true });
	});

	const fetchData = (
		id: string,
		content = "full page body",
	): StoredSearchData & { type: "fetch"; urls: ExtractedContent[] } => ({
		id,
		type: "fetch",
		timestamp: Date.now(),
		urls: [{ url: "https://a.test", title: "A", content, error: null }],
	});

	it("keeps the body out of the session entry and restores it from disk", () => {
		const sessionData = storeFetchedContentResult("abc", fetchData("abc"));

		expect(JSON.stringify(sessionData)).not.toContain("full page body");
		expect(sessionData.urlMetadata?.[0]).toMatchObject({ url: "https://a.test", title: "A", contentLength: 14 });

		clearResults();
		restoreFromSession(makeContext([{ type: "custom", customType: "web-search-results", data: sessionData }]));

		expect(getResult("abc")?.urls?.[0].content).toBe("full page body");
	});

	it.skipIf(process.platform === "win32")("creates the cache with private permissions", () => {
		storeFetchedContentResult("abc", fetchData("abc"));
		const dir = join(root, "web-search-cache");

		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "abc.json")).mode & 0o777).toBe(0o600);
	});

	it("reports a clear error when the cache file is gone", () => {
		const sessionData = storeFetchedContentResult("abc", fetchData("abc"));
		rmSync(join(root, "web-search-cache", "abc.json"));

		clearResults();
		restoreFromSession(makeContext([{ type: "custom", customType: "web-search-results", data: sessionData }]));

		const loaded = getResult("abc");
		expect(loaded?.urls?.[0]).toMatchObject({ url: "https://a.test", content: "" });
		expect(loaded?.urls?.[0].error).toMatch(/missing or expired/);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"retries a cache read that failed for a transient reason instead of remembering the failure",
		() => {
			const sessionData = storeFetchedContentResult("abc", fetchData("abc"));
			clearResults();
			restoreFromSession(makeContext([{ type: "custom", customType: "web-search-results", data: sessionData }]));
			const file = join(root, "web-search-cache", "abc.json");

			chmodSync(file, 0o000);
			try {
				expect(getResult("abc")?.urls?.[0].error).toMatch(/could not be read/);
			} finally {
				chmodSync(file, 0o600);
			}

			expect(getResult("abc")?.urls?.[0].content).toBe("full page body");
		},
	);

	it("still reads legacy session entries that carry the body inline", () => {
		const legacy = fetchData("legacy");
		restoreFromSession(makeContext([{ type: "custom", customType: "web-search-results", data: legacy }]));

		expect(getResult("legacy")?.urls?.[0].content).toBe("full page body");
	});

	it("removes the oldest entries beyond 128 files", () => {
		for (let i = 0; i < 130; i++) {
			storeFetchedContentResult(`id${i}`, fetchData(`id${i}`));
			const file = join(root, "web-search-cache", `id${i}.json`);
			// Distinct mtimes so "oldest" is well defined.
			utimesSync(file, new Date(Date.now() - (200 - i) * 1000), new Date(Date.now() - (200 - i) * 1000));
		}

		const files = readdirSync(join(root, "web-search-cache"));
		expect(files.length).toBeLessThanOrEqual(128);
		expect(files).toContain("id129.json");
		expect(files).not.toContain("id0.json");
	});

	it("drops cache files older than one hour", () => {
		storeFetchedContentResult("old", fetchData("old"));
		const old = new Date(Date.now() - 61 * 60 * 1000);
		utimesSync(join(root, "web-search-cache", "old.json"), old, old);

		storeFetchedContentResult("new", fetchData("new"));

		expect(readdirSync(join(root, "web-search-cache"))).toEqual(["new.json"]);
	});

	it("deleting a result removes its cache file", () => {
		storeFetchedContentResult("abc", fetchData("abc"));
		deleteResult("abc");

		expect(existsSync(join(root, "web-search-cache", "abc.json"))).toBe(false);
	});
});
