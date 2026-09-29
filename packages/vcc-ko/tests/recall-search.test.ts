import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatRecallOutput } from "../src/core/format-recall.ts";
import { filterLoadedByRole, loadAllMessages } from "../src/core/load-messages.ts";
import { searchEntriesDetailed } from "../src/core/search-entries.ts";

const messageEntry = (id: string, message: unknown) => ({ type: "message", id, parentId: null, message });
const customEntry = (id: string, customType: string, content: string) => ({
	type: "custom_message",
	id,
	parentId: null,
	customType,
	content,
	display: true,
	details: {},
});

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 });
const toolResult = (name: string, text: string) => ({
	role: "toolResult",
	toolCallId: "tc_1",
	toolName: name,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

let dir: string;

const writeSession = (entries: unknown[]): string => {
	const file = join(dir, `session-${Math.random().toString(36).slice(2)}.jsonl`);
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return file;
};

const search = (file: string, query: string, role?: Parameters<typeof filterLoadedByRole>[1]) => {
	const loaded = filterLoadedByRole(loadAllMessages(file, false, undefined, { includeCustom: true }), role);
	return searchEntriesDetailed(loaded.rendered, loaded.rawMessages, query);
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcc-recall-search-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("query matching", () => {
	it("matches bracketed text literally instead of as a character class", () => {
		const file = writeSession([
			messageEntry("m1", user("please run the worker")),
			messageEntry("m2", assistant("the assistant is thinking about a plan")),
			customEntry("c1", "subagent-tool", "[subagent:worker#41] completed\nPrompt: fix the cache layer"),
			messageEntry("m3", assistant("I saw [subagent:worker#41] finish and merged the result")),
			messageEntry("m4", assistant("unrelated work on the parser")),
		]);

		const { hits } = search(file, "[subagent:worker#41]");
		expect(hits.map((h) => h.ref)).toEqual(["c0", "2"]);
	});

	it("reports no match for a bracketed token that does not occur, instead of matching every entry", () => {
		const file = writeSession([
			messageEntry("m1", user("please run the worker")),
			messageEntry("m2", assistant("the assistant is thinking about a plan")),
			customEntry("c1", "subagent-tool", "[subagent:worker#41] completed"),
		]);

		expect(search(file, "[nonexistent:token#9]").hits).toEqual([]);
	});

	it("still treats a genuine alternation as a regex", () => {
		const file = writeSession([
			messageEntry("m1", user("alpha release notes")),
			messageEntry("m2", assistant("beta rollout tomorrow")),
			messageEntry("m3", assistant("nothing relevant here")),
		]);

		const { hits } = search(file, "alpha|beta");
		expect(hits.map((h) => h.ref)).toEqual(["0", "1"]);
	});

	it("falls back to term search for prose that ends in a question mark", () => {
		const file = writeSession([
			messageEntry("m1", user("we picked redis for the session store")),
			messageEntry("m2", assistant("the rollback plan is documented in ops.md")),
			messageEntry("m3", assistant("lunch menu discussion")),
		]);

		const { hits } = search(file, "redis cache rollback plan?");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.map((h) => h.ref).sort()).toEqual(["0", "1"]);
	});

	it("does not match entries through their role name", () => {
		const file = writeSession([
			messageEntry("m1", user("who wrote this assistant prompt?")),
			messageEntry("m2", assistant("the cache layer is warm")),
			messageEntry("m3", toolResult("Read", "nothing to see")),
		]);

		const { hits } = search(file, "assistant");
		expect(hits.map((h) => h.ref)).toEqual(["0"]);
	});
});

describe("role filter", () => {
	const file = () =>
		writeSession([
			messageEntry("m1", user("deploy the cache service tonight")),
			messageEntry("m2", assistant("I will deploy the cache service")),
			messageEntry("m3", toolResult("Bash", "deploy the cache service: done")),
			customEntry("c1", "subagent-tool", "[subagent:worker#2] deploy the cache service finished"),
		]);

	it("keeps only entries of the requested role", () => {
		const { hits } = search(file(), "deploy cache service", "user");
		expect(hits).toHaveLength(1);
		expect(hits[0].ref).toBe("0");
		expect(hits[0].role).toBe("user");
	});

	it("can narrow to extension messages", () => {
		const { hits } = search(file(), "deploy cache service", "custom");
		expect(hits.map((h) => h.ref)).toEqual(["c0"]);
	});

	it("searches every role when no filter is given", () => {
		const { hits } = search(file(), "deploy cache service");
		expect(hits.length).toBeGreaterThanOrEqual(4);
	});
});

describe("duplicate folding", () => {
	const longResult =
		"export const CACHE_TTL = 300;\n" +
		"// The cache entry lives for five minutes so the dashboard stays responsive\n" +
		"export const CACHE_PREFIX = 'session:';\n";

	it("folds identical long results into the first hit", () => {
		const file = writeSession([
			messageEntry("m1", toolResult("Read", longResult)),
			messageEntry("m2", assistant("checking again")),
			messageEntry("m3", toolResult("Read", longResult)),
			messageEntry("m4", toolResult("Read", longResult)),
		]);

		const { hits, totalBeforeCap, truncated } = search(file, "CACHE_TTL");
		expect(hits).toHaveLength(1);
		expect(hits[0].ref).toBe("0");
		expect(hits[0].duplicateRefs).toEqual(["2", "3"]);
		expect(totalBeforeCap).toBe(1);
		expect(truncated).toBe(false);
		expect(formatRecallOutput(hits, "CACHE_TTL")).toContain("(same content also at #2, #3)");
	});

	it("leaves short identical texts alone", () => {
		const file = writeSession([
			messageEntry("m1", toolResult("Bash", "ok done")),
			messageEntry("m2", toolResult("Bash", "ok done")),
		]);
		const { hits } = search(file, "ok done");
		expect(hits.map((h) => h.ref)).toEqual(["0", "1"]);
		expect(hits[0].duplicateRefs).toBeUndefined();
	});

	it("does not fold texts that merely share a prefix", () => {
		const file = writeSession([
			messageEntry("m1", toolResult("Read", `${longResult}// first variant`)),
			messageEntry("m2", toolResult("Read", `${longResult}// second variant`)),
		]);
		const { hits } = search(file, "CACHE_TTL");
		expect(hits.map((h) => h.ref)).toEqual(["0", "1"]);
	});
});
