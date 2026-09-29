import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerVccRecallCommand } from "../src/commands/vcc-recall.ts";

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

// 12 matching entries → 3 pages at PAGE_SIZE 5, so the "next page" hint renders.
const ENTRIES = [
	...Array.from({ length: 6 }, (_, i) => messageEntry(`u${i}`, user(`cache question number ${i}`))),
	...Array.from({ length: 6 }, (_, i) => messageEntry(`a${i}`, assistant(`cache answer number ${i}`))),
	customEntry("cm0", "subagent-tool", "[subagent:worker#3] cache warmup finished"),
];

let dir: string;
let sessionFile: string;

const runCommand = async (args: string): Promise<string> => {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const sent: string[] = [];
	const pi = {
		registerCommand: (_name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
			handler = options.handler;
		},
		sendMessage: (msg: { content: string }) => sent.push(msg.content),
	} as unknown as ExtensionAPI;
	registerVccRecallCommand(pi);
	await handler!(args, {
		sessionManager: {
			getSessionFile: () => sessionFile,
			getBranch: () => ENTRIES.map((e) => ({ id: e.id })),
		},
		ui: { notify: () => {} },
	});
	return sent.join("\n");
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcc-recall-cmd-"));
	sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, `${ENTRIES.map((e) => JSON.stringify(e)).join("\n")}\n`);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("/pi-vcc-ko-recall", () => {
	it("points pagination hints at the command that actually exists", async () => {
		const output = await runCommand("cache");
		expect(output).toContain("--- /pi-vcc-ko-recall cache page:2 ---");
		expect(output).not.toContain("/pi-vcc-recall ");
	});

	it("reports the reachable page range with the real command name", async () => {
		const output = await runCommand("cache page:99");
		expect(output).toContain("Use /pi-vcc-ko-recall cache page:N with N between 1 and 3");
	});

	it("keeps the role token in its hints and filters by it", async () => {
		const output = await runCommand("cache role:user");
		expect(output).toContain("--- /pi-vcc-ko-recall cache role:user page:2 ---");
		expect(output).not.toContain("[assistant]");
		expect(output).not.toContain("[custom:");
	});

	it("includes custom entries in recent listings", async () => {
		const output = await runCommand("");
		expect(output).toContain("#c0 [custom:subagent-tool]");
	});
});
