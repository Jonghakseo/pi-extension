import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerRecallTool } from "../src/tools/recall.ts";

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
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 });
const systemMessage = () => ({ role: "system", content: "", sections: [{ name: "identity" }], timestamp: 1 });

const LONG_REPORT =
	"[subagent:worker#41] completed\n" +
	"Prompt: migrate the session store to redis\n" +
	"Result: TTL set to 300 seconds, keys prefixed with session:, rollout behind a flag.";

const SESSION_ENTRIES = [
	messageEntry("m0", systemMessage()),
	messageEntry("m1", user("migrate the session store, and keep asking me before deploying")),
	customEntry("cm0", "subagent-tool", LONG_REPORT),
	messageEntry("m2", assistant("dispatched the worker")),
	customEntry("cm1", "bash-async-completion", "[bash_async job] pnpm test\n114 passed"),
	messageEntry("m3", assistant("")),
];

let dir: string;
let sessionFile: string;

// Exercise the real registration path: capture the ToolDefinition pi would get.
const recallTool = () => {
	let tool: any;
	registerRecallTool({ registerTool: (t: unknown) => (tool = t) } as unknown as ExtensionAPI);
	return tool;
};

const run = async (params: Record<string, unknown>, entries: unknown[] = SESSION_ENTRIES): Promise<string> => {
	const ctx = {
		sessionManager: {
			getSessionFile: () => sessionFile,
			getBranch: () => entries.map((e: any) => ({ id: e.id })),
		},
	};
	const result = await recallTool().execute("tc_1", params, undefined, undefined, ctx);
	return result.content.map((c: { text: string }) => c.text).join("\n");
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcc-recall-tool-"));
	sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, `${SESSION_ENTRIES.map((e) => JSON.stringify(e)).join("\n")}\n`);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("vcc_recall expand", () => {
	it("accepts custom and message refs together", async () => {
		const text = await run({ expand: ["c0", "#1"] });
		expect(text).toContain("#c0 [custom:subagent-tool]");
		expect(text).toContain("rollout behind a flag");
		expect(text).toContain("#1 [user]");
		expect(text).toContain("keep asking me before deploying");
	});

	it("treats a bare ref query as an expand request", async () => {
		const text = await run({ query: "#c0" });
		expect(text).toContain("#c0 [custom:subagent-tool]");
		expect(text).toContain("TTL set to 300 seconds");
	});

	it("names refs it cannot reach", async () => {
		const text = await run({ expand: ["c9", 99, "nonsense"] });
		expect(text).toContain("Cannot expand indices outside active lineage");
		expect(text).toContain("c9");
		expect(text).toContain("99");
		expect(text).toContain("nonsense");
	});

	it("cannot expand a hidden system message", async () => {
		const text = await run({ expand: [0] });
		expect(text).toContain("Cannot expand indices outside active lineage: 0");
	});
});

describe("vcc_recall search", () => {
	it("finds text that only exists in a custom_message", async () => {
		const text = await run({ query: "[subagent:worker#41]" });
		expect(text).toContain("#c0 [custom:subagent-tool]");
		expect(text).toContain("1 matches");
	});

	it("narrows to the user's own instructions with role", async () => {
		const text = await run({ query: "session store", role: "user" });
		expect(text).toContain("#1 [user]");
		expect(text).not.toContain("[custom:subagent-tool]");
	});
});

describe("vcc_recall browse", () => {
	it("lists customs and drops empty-bodied entries", async () => {
		const text = await run({});
		expect(text).toContain("#c0 [custom:subagent-tool]");
		expect(text).toContain("#c1 [custom:bash-async-completion]");
		expect(text).toContain("#1 [user]");
		expect(text).not.toContain("#3 [assistant]");
		expect(text).not.toContain("#0 [");
	});
});
