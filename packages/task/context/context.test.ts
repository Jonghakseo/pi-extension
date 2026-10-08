import { describe, expect, it } from "vitest";
import { buildContextSnapshot, MAX_BRIEF_CHARS, queryContext, REF_PAGE_CHARS } from "./context.ts";

const userEntry = (id: string, text: string) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text }] },
});

const assistantEntry = (id: string, text: string, extra: unknown[] = []) => ({
	type: "message",
	id,
	message: { role: "assistant", content: [{ type: "text", text }, ...extra] },
});

const toolResultEntry = (id: string, toolName: string, text: string, isError = false) => ({
	type: "message",
	id,
	message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] },
});

describe("buildContextSnapshot", () => {
	it("keeps large originals accessible beyond the former 200k truncation boundary", () => {
		const original = `${"x".repeat(210_000)}important tail`;
		const snapshot = buildContextSnapshot([userEntry("large", original)]);
		expect(snapshot.entries[0].text).toBe(original);
		expect(queryContext(snapshot, { refs: ["large"], offset: 210_000 })).toContain("important tail");
	});

	it("keeps the first user goal and the latest instructions in the brief", () => {
		const snapshot = buildContextSnapshot([
			userEntry("u1", "Refactor the billing retry logic so failed charges are retried twice"),
			assistantEntry("a1", "Looking at billing.ts"),
			userEntry("u2", "Also keep the existing Sentry breadcrumbs"),
			userEntry("u3", "Do not touch the webhook handler"),
		]);

		expect(snapshot.brief).toContain("[u1] first user goal: Refactor the billing retry logic");
		expect(snapshot.brief).toContain("[u3] user: Do not touch the webhook handler");
		expect(snapshot.brief).toContain("[u2] user: Also keep the existing Sentry breadcrumbs");
		expect(snapshot.brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS + 80);
		expect(snapshot.entries.map((entry) => entry.ref)).toEqual(["u1", "a1", "u2", "u3"]);
	});

	it("leads with the newest compaction summary", () => {
		const snapshot = buildContextSnapshot([
			userEntry("u1", "original goal"),
			{ type: "compaction", id: "c1", summary: "Earlier: migrated the auth module and fixed two tests." },
			userEntry("u2", "now add rate limiting"),
		]);

		expect(snapshot.brief.split("\n")[0]).toContain("earlier conversation summary: Earlier: migrated the auth module");
		expect(snapshot.brief).toContain("first user goal (before the summary)");
	});

	it("carries tool results, custom messages and tool calls but drops thinking, images and state entries", () => {
		const snapshot = buildContextSnapshot([
			userEntry("u1", "run the tests"),
			assistantEntry("a1", "running", [
				{ type: "thinking", thinking: "secret chain of thought" },
				{ type: "toolCall", name: "bash_async", arguments: { command: "pnpm test" } },
			]),
			toolResultEntry("t1", "bash_async", "job 7 finished: 3 passed", false),
			{
				type: "custom_message",
				id: "m1",
				customType: "bash-async-result",
				display: true,
				content: "job 7 output: coverage 98%",
			},
			{ type: "model_change", id: "x1", provider: "anthropic", modelId: "claude-sonnet-5-5" },
			{ type: "usage", id: "x2", kind: "cache_warm" },
			{ type: "message", id: "x3", message: { role: "system", content: "you are pi" } },
			null,
			"garbage",
		]);

		const refs = snapshot.entries.map((entry) => entry.ref);
		expect(refs).toEqual(["u1", "a1", "t1", "m1"]);
		expect(snapshot.entries[1].text).toContain("[tool call: bash_async]");
		expect(snapshot.entries[1].text).not.toContain("secret chain of thought");
		expect(snapshot.entries[2].role).toBe("toolResult:bash_async");
		expect(snapshot.entries[3].role).toBe("custom:bash-async-result");
	});

	it("redacts obvious credentials and generates refs for entries without ids", () => {
		const snapshot = buildContextSnapshot([
			{ type: "message", message: { role: "user", content: "use token sk-abcdefghijklmnopqrstuvwx please" } },
			{ type: "message", message: { role: "assistant", content: 'config: {"api_key": "hunter2-very-secret"}' } },
		]);

		expect(snapshot.entries.map((entry) => entry.ref)).toEqual(["e1", "e2"]);
		expect(snapshot.entries[0].text).toBe("use token [redacted] please");
		expect(snapshot.entries[1].text).toContain('"api_key": [redacted]');
	});

	it("survives corrupt input", () => {
		expect(buildContextSnapshot([]).entries).toEqual([]);
		expect(buildContextSnapshot([{ type: "message" }, { type: "message", message: {} }]).entries).toEqual([]);
		expect(buildContextSnapshot(undefined as unknown as unknown[]).brief).toBe("");
	});
});

describe("queryContext", () => {
	const longText = Array.from({ length: 400 }, (_, index) => `line ${index} of the migration plan`).join("\n");
	const snapshot = buildContextSnapshot([
		userEntry("u1", "migrate the payment module to the new gateway"),
		assistantEntry("a1", longText),
		toolResultEntry("t1", "bash_async", "job 3 finished: migration dry-run succeeded"),
		userEntry("u2", "keep the legacy webhook route alive"),
	]);

	it("lists the brief and every ref when called without arguments", () => {
		const output = queryContext(snapshot);

		expect(output).toContain("first user goal");
		expect(output).toContain("- [t1] toolResult:bash_async");
		expect(output).toContain("4 context entries");
	});

	it("finds async job results by keyword and points at the full entry", () => {
		const output = queryContext(snapshot, { query: "dry-run" });

		expect(output).toContain("[t1] toolResult:bash_async");
		expect(output).toContain("migration dry-run succeeded");
		expect(output).toContain('1 matches for "dry-run"');
	});

	it("pages long search results and reports the next offset", () => {
		const first = queryContext(snapshot, { query: "migration", limit: 1 });
		expect(first).toContain("showing 1-1");
		expect(first).toContain('next: task_context query="migration" offset=1');

		const second = queryContext(snapshot, { query: "migration", limit: 1, offset: 1 });
		expect(second).toContain("showing 2-2");
		expect(second).not.toBe(first);
	});

	it("reads an entry's full original text through ref pagination", () => {
		const entry = snapshot.entries.find((candidate) => candidate.ref === "a1");
		expect(entry).toBeDefined();
		const total = entry?.text.length ?? 0;
		expect(total).toBeGreaterThan(REF_PAGE_CHARS);

		let offset = 0;
		let assembled = "";
		let pages = 0;
		while (offset < total && pages < 50) {
			const page = queryContext(snapshot, { refs: ["a1"], offset });
			const body = page
				.split("\n")
				.slice(1)
				.join("\n")
				.replace(/\n(?:…\[more\].*|\[end of entry\])$/s, "");
			assembled += body;
			offset += REF_PAGE_CHARS;
			pages += 1;
		}

		expect(assembled).toBe(entry?.text);
		expect(queryContext(snapshot, { refs: ["a1"], offset: total - 10 })).toContain("[end of entry]");
	});

	it("reports unknown refs and empty searches without throwing", () => {
		expect(queryContext(snapshot, { refs: ["nope"] })).toContain("not found");
		expect(queryContext(snapshot, { query: "quantum tunneling" })).toContain("No context entry matches");
		expect(queryContext({ brief: "", entries: [] })).toContain("No prior context");
		expect(queryContext({ brief: "", entries: undefined as unknown as [] })).toContain("No prior context");
	});

	it("clamps hostile pagination input", () => {
		expect(queryContext(snapshot, { refs: ["u1"], offset: -5, limit: -1 })).toContain("chars 0-");
		expect(queryContext(snapshot, { query: "migration", offset: 999 })).toContain("No further matches");
	});
});
