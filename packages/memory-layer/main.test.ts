import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/memory-layer-functional-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const mocked = { ...actual, homedir: () => testHome };
	return { ...mocked, default: mocked };
});

import { registerMemoryLayer } from "./main.ts";
import { memoryEntryId } from "./storage.ts";

type RegisteredTool = {
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal,
		onUpdate: () => void,
		ctx: unknown,
	) => Promise<unknown>;
};

const testRoot = path.join(testHome, "test-artifacts");
const sessionDir = path.join(testRoot, "sessions");
const cwd = path.join(testRoot, "cwd");

function createHarness(sessionManager: SessionManager) {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: { name: string } & RegisteredTool) => tools.set(tool.name, tool),
		appendEntry: (customType: string, data?: unknown) => sessionManager.appendCustomEntry(customType, data),
	};
	const handlers = registerMemoryLayer(pi as never);
	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify: vi.fn() },
		sessionManager,
	};
	return {
		ctx,
		handlers,
		async execute(name: string, params: unknown) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Tool not registered: ${name}`);
			return tool.execute("test", params, new AbortController().signal, () => {}, ctx);
		},
	};
}

function resultText(result: unknown): string {
	return (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
}

beforeEach(async () => {
	vi.stubEnv("PI_CODING_AGENT_DIR", "");
	await fs.rm(testHome, { recursive: true, force: true });
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(sessionDir, { recursive: true });
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(testHome, { recursive: true, force: true });
});

describe("registered memory tools", () => {
	it("round-trips tiers, preserves legacy IDs, filters every recall mode, and ranks only matching memories", async () => {
		const session = SessionManager.create(cwd, sessionDir);
		const harness = createHarness(session);

		await harness.execute("remember", {
			scope: "user",
			tier: "profile",
			topic: "rules",
			title: "Weak profile match",
			content: "release",
		});
		await harness.execute("remember", {
			scope: "user",
			tier: "note",
			topic: "rules",
			title: "Strong note match",
			content: "release checklist release checklist",
		});
		await harness.execute("remember", {
			scope: "user",
			tier: "profile",
			topic: "other",
			title: "Unrelated profile",
			content: "calendar preference",
		});
		const literalTierBody = "<!-- @tier: note -->\nThis is ordinary memory text.";
		await harness.execute("remember", {
			scope: "user",
			tier: "log",
			topic: "rules",
			title: "Literal tier body",
			content: literalTierBody,
		});

		const legacyTitle = "Legacy entry";
		const legacyContent = "legacy release rule";
		const legacyMarker = Buffer.from(legacyTitle, "utf8").toString("base64");
		const legacyPath = path.join(testHome, ".pi", "memory", "user", "legacy.md");
		await fs.writeFile(legacyPath, `# Legacy\n\n<!-- @entry: ${legacyMarker} -->\n${legacyContent}\n`, "utf8");

		const query = resultText(await harness.execute("recall", { query: "release checklist" }));
		expect(query.indexOf("[user/profile] rules/Weak profile match")).toBeLessThan(
			query.indexOf("[user/note] rules/Strong note match"),
		);
		expect(query).not.toContain("Unrelated profile");

		const noteQuery = resultText(
			await harness.execute("recall", { query: "release checklist", scope: "user", tier: "note" }),
		);
		expect(noteQuery).toContain("Strong note match");
		expect(noteQuery).not.toContain("Weak profile match");

		const literalId = memoryEntryId("user", undefined, "rules", "Literal tier body", literalTierBody);
		expect(resultText(await harness.execute("recall", { id: literalId }))).toContain(literalTierBody);

		const legacyId = memoryEntryId("user", undefined, "legacy", legacyTitle, legacyContent);
		const legacyById = resultText(await harness.execute("recall", { id: legacyId, tier: "profile" }));
		expect(legacyById).toContain(legacyContent);
		await expect(harness.execute("recall", { id: legacyId, tier: "note" })).rejects.toThrow("Memory not found");

		const globalIndex = resultText(await harness.execute("recall", {}));
		expect(globalIndex.indexOf("Weak profile match")).toBeLessThan(globalIndex.indexOf("Literal tier body"));
		expect(globalIndex.indexOf("Literal tier body")).toBeLessThan(globalIndex.indexOf("Strong note match"));
		const globalList = resultText(await harness.execute("memory_list", {}));
		expect(globalList.indexOf("Weak profile match")).toBeLessThan(globalList.indexOf("Literal tier body"));
		expect(globalList.indexOf("Literal tier body")).toBeLessThan(globalList.indexOf("Strong note match"));

		const index = resultText(await harness.execute("recall", { tier: "note" }));
		expect(index).toContain("Strong note match");
		expect(index).not.toContain("Weak profile match");
		const list = resultText(await harness.execute("memory_list", { scope: "user", tier: "note" }));
		expect(list).toContain("Strong note match");
		expect(list).not.toContain("Weak profile match");

		await harness.handlers.onMemoryCommand("release --scope user --tier note", harness.ctx as never);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith("[user/note] rules/Strong note match", "info");
		expect(harness.ctx.ui.notify).not.toHaveBeenCalledWith("[user/profile] rules/Weak profile match", "info");
	});

	it("persists agent memories in a session, excludes other sessions and forks, and replays tombstones", async () => {
		const session = SessionManager.create(cwd, sessionDir);
		const harness = createHarness(session);
		await harness.execute("remember", {
			scope: "agent",
			tier: "log",
			topic: "current-task",
			title: "Temporary session rule",
			content: "Only the original session can recall this.",
		});

		session.appendMessage({
			role: "assistant",
			content: [],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const reopened = createHarness(SessionManager.open(sessionFile as string, sessionDir));
		expect(resultText(await reopened.execute("recall", { scope: "agent" }))).toContain("Temporary session rule");

		const other = createHarness(SessionManager.create(cwd, sessionDir));
		expect(resultText(await other.execute("recall", { scope: "agent" }))).toBe("No memories stored.");

		const fork = createHarness(SessionManager.forkFrom(sessionFile as string, cwd, sessionDir));
		expect(resultText(await fork.execute("recall", { scope: "agent" }))).toBe("No memories stored.");

		await reopened.execute("forget", { scope: "agent", title: "Temporary session rule" });
		const reopenedAfterForget = createHarness(SessionManager.open(sessionFile as string, sessionDir));
		expect(resultText(await reopenedAfterForget.execute("recall", { scope: "agent" }))).toBe("No memories stored.");
	});
});
