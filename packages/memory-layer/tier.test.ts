import { describe, expect, it } from "vitest";
import {
	findMemoryInEntries,
	memoryEntryId,
	parseIndex,
	parseTopicFile,
	type SearchResult,
	searchMemoryEntries,
} from "./storage.ts";

const memories: SearchResult[] = [
	{ scope: "user", topic: "general", title: "Profile match", content: "release checklist", tier: "profile" },
	{
		scope: "project",
		projectId: "repo",
		topic: "general",
		title: "Log match",
		content: "release checklist",
		tier: "log",
	},
	{
		scope: "agent",
		projectId: "session-a",
		topic: "general",
		title: "Note match",
		content: "release checklist",
		tier: "note",
	},
];

describe("memory tiers", () => {
	it("reads legacy entries as profile and preserves explicit marker tiers", () => {
		const legacy = parseTopicFile("# General\n\n## Existing\nlegacy content");
		const metadata = Buffer.from(JSON.stringify({ title: "Recent", tier: "log" }), "utf8").toString("base64");
		const current = parseTopicFile(`# General\n\n<!-- memory-layer-entry:v2: ${metadata} -->\nrecent content`);
		const oldMarkerTitle = Buffer.from("Old marker", "utf8").toString("base64");
		const oldMarker = parseTopicFile(
			`# General\n\n<!-- @entry: ${oldMarkerTitle} -->\n<!-- @tier: note -->\nbody text`,
		);

		expect(legacy.entries[0].tier).toBe("profile");
		expect(current.entries[0]).toMatchObject({ title: "Recent", tier: "log", content: "recent content" });
		expect(oldMarker.entries[0]).toMatchObject({
			title: "Old marker",
			tier: "profile",
			content: "<!-- @tier: note -->\nbody text",
		});
		expect(parseIndex("<!-- memory-layer-index:v2 -->\n## general.md\n- [note] Existing").at(0)?.entries[0]).toEqual({
			title: "Existing",
			tier: "note",
		});
		expect(parseIndex("## general.md\n- [note] Literal title").at(0)?.entries[0]).toEqual({
			title: "[note] Literal title",
			tier: "profile",
		});
	});

	it("prioritizes tiers after matching and applies scope and tier filters to query and ID recall", () => {
		const results = searchMemoryEntries(memories, "release checklist");
		expect(results.map((entry) => entry.tier)).toEqual(["profile", "log", "note"]);
		expect(searchMemoryEntries(memories, "release checklist", { scope: "project" })).toEqual([memories[1]]);
		expect(searchMemoryEntries(memories, "release checklist", { tier: "note" })).toEqual([memories[2]]);

		const id = memoryEntryId("user", undefined, "general", "Profile match", "release checklist");
		expect(findMemoryInEntries(memories, id, { scope: "user", tier: "profile" })).toEqual(memories[0]);
		expect(findMemoryInEntries(memories, id, { scope: "project" })).toBeNull();
		expect(findMemoryInEntries(memories, id, { tier: "log" })).toBeNull();
	});
});
