import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandEntryFile } from "../src/core/drill-down.ts";
import { formatRecallOutput } from "../src/core/format-recall.ts";
import { loadAllMessages } from "../src/core/load-messages.ts";
import { searchEntries } from "../src/core/search-entries.ts";

// Real-shaped session entries: pi persists one JSON object per line.
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

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string, toolCall?: { name: string; arguments: Record<string, unknown> }) => ({
	role: "assistant",
	content: [
		{ type: "text", text },
		...(toolCall ? [{ type: "toolCall", id: "tc_1", name: toolCall.name, arguments: toolCall.arguments }] : []),
	],
	timestamp: 1,
});
const systemMessage = () => ({
	role: "system",
	content: "",
	sections: [{ name: "identity", content: "You are Pi." }],
	timestamp: 1,
});

let dir: string;

const writeSession = (entries: unknown[]): string => {
	const file = join(dir, `session-${Math.random().toString(36).slice(2)}.jsonl`);
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return file;
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcc-recall-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("custom_message entries", () => {
	const subagentReport = "[subagent:worker#41] completed\nPrompt: fix the cache\nRedis TTL is now 300 seconds.";

	const session = () => [
		messageEntry("m1", user("start the work")),
		customEntry("c1", "subagent-tool", subagentReport),
		messageEntry("m2", assistant("done")),
		customEntry("c2", "bash-async-completion", "[bash_async job] tests finished\n114 passed"),
	];

	it("is searchable and shown with its #cN ref and customType", () => {
		const file = writeSession(session());
		const { rendered, rawMessages } = loadAllMessages(file, false, undefined, { includeCustom: true });

		const hits = searchEntries(rendered, rawMessages, "Redis TTL");
		expect(hits.map((h) => h.ref)).toContain("c0");

		const output = formatRecallOutput(hits, "Redis TTL");
		expect(output).toContain("#c0 [custom:subagent-tool]");
	});

	it("finds background job completions too", () => {
		const file = writeSession(session());
		const { rendered, rawMessages } = loadAllMessages(file, false, undefined, { includeCustom: true });
		const hits = searchEntries(rendered, rawMessages, "114 passed");
		expect(hits.map((h) => h.ref)).toEqual(["c1"]);
	});

	it("leaves message #N values untouched", () => {
		const file = writeSession(session());
		const withoutCustom = loadAllMessages(file, false);
		const withCustom = loadAllMessages(file, false, undefined, { includeCustom: true });

		expect(withoutCustom.rendered.map((e) => e.ref)).toEqual(["0", "1"]);
		expect(withCustom.rendered.filter((e) => e.role !== "custom").map((e) => e.ref)).toEqual(
			withoutCustom.rendered.map((e) => e.ref),
		);
		expect(withCustom.rendered.map((e) => e.ref)).toEqual(["0", "c0", "1", "c1"]);
	});

	it("skips empty custom entries but keeps counting them", () => {
		const file = writeSession([
			messageEntry("m1", user("hello")),
			customEntry("c1", "noise", "   "),
			customEntry("c2", "subagent-tool", "[subagent:worker#7] completed"),
		]);
		const { rendered } = loadAllMessages(file, false, undefined, { includeCustom: true });
		expect(rendered.filter((e) => e.role === "custom").map((e) => e.ref)).toEqual(["c1"]);
	});

	it("never indexes the recall command's own output, which would make repeated queries match themselves", () => {
		const file = writeSession([
			messageEntry("m1", user("redis ttl decision")),
			customEntry("c1", "vcc-recall", '3 matches for "redis ttl":\n\n#0 [user] redis ttl decision'),
			customEntry("c2", "subagent-tool", "[subagent:worker#7] completed"),
		]);
		const { rendered, rawMessages } = loadAllMessages(file, false, undefined, { includeCustom: true });
		expect(rendered.filter((e) => e.role === "custom").map((e) => e.ref)).toEqual(["c1"]);
		expect(searchEntries(rendered, rawMessages, "matches for").map((h) => h.ref)).toEqual([]);
	});

	it("is excluded by default so message-only callers are unaffected", () => {
		const file = writeSession(session());
		const { rendered, rawMessages } = loadAllMessages(file, false);
		expect(rendered.every((e) => e.role !== "custom")).toBe(true);
		expect(rawMessages).toHaveLength(rendered.length);
	});
});

describe("system messages", () => {
	it("are hidden but still consume their #N", () => {
		const file = writeSession([
			messageEntry("m0", systemMessage()),
			messageEntry("m1", user("first real turn")),
			messageEntry("m2", assistant("answering")),
		]);
		const { rendered } = loadAllMessages(file, false);

		expect(rendered.map((e) => e.ref)).toEqual(["1", "2"]);
		expect(rendered[0].role).toBe("user");
		expect(formatRecallOutput(rendered)).toContain("#1 [user] first real turn");
		expect(formatRecallOutput(rendered)).not.toContain("[assistant] \n");
	});
});

describe("drill-down", () => {
	it("resolves #N:path when a system message precedes the target", () => {
		const file = writeSession([
			messageEntry("m0", systemMessage()),
			messageEntry("m1", user("write the config")),
			messageEntry(
				"m2",
				assistant("writing", {
					name: "Write",
					arguments: { path: "/tmp/app/config.ts", content: "export const port = 8080;" },
				}),
			),
		]);

		const text = expandEntryFile(file, 2, "config.ts");
		expect(text).toContain("File: /tmp/app/config.ts");
		expect(text).toContain("export const port = 8080;");
	});

	it("reports a miss for an index that holds no file content", () => {
		const file = writeSession([messageEntry("m0", systemMessage()), messageEntry("m1", user("no files here"))]);
		expect(expandEntryFile(file, 1, "config.ts")).toContain('No file content found in entry #1 for "config.ts"');
		expect(expandEntryFile(file, 0, "config.ts")).toContain("Entry #0 not found");
	});
});
