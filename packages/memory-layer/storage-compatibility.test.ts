import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = vi.hoisted(() => `${process.env.TMPDIR ?? "/tmp"}/memory-layer-compat-${process.pid}`);

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const mocked = { ...actual, homedir: () => testHome };
	return { ...mocked, default: mocked };
});

import { loadTopicEntries, readMemoryMd, saveMemory } from "./storage.ts";

const execFile = promisify(execFileCallback);
const v033StorageCommit = "27e87d4";
const v040StorageCommit = "9f1c2ce";

beforeEach(async () => {
	vi.stubEnv("PI_CODING_AGENT_DIR", "");
	await fs.rm(testHome, { recursive: true, force: true });
	await fs.mkdir(testHome, { recursive: true });
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(testHome, { recursive: true, force: true });
});

async function runHistoricalWriter(revision: string, version: string, title: string, content: string): Promise<void> {
	const sourceDir = path.join(testHome, `memory-layer-${version}`);
	const storagePath = path.join(sourceDir, "storage.ts");
	const scriptPath = path.join(sourceDir, "write.mts");
	const { stdout } = await execFile("git", ["show", `${revision}:packages/memory-layer/storage.ts`], {
		cwd: process.cwd(),
	});
	await fs.mkdir(sourceDir, { recursive: true });
	await fs.writeFile(storagePath, stdout, "utf8");
	await fs.writeFile(
		scriptPath,
		`import { saveMemory } from "./storage.ts";\nawait saveMemory("user", undefined, "general", "General", ${JSON.stringify(title)}, ${JSON.stringify(content)});\n`,
		"utf8",
	);
	await execFile(process.execPath, ["--experimental-strip-types", scriptPath], {
		env: { ...process.env, HOME: testHome, PI_CODING_AGENT_DIR: "" },
	});
}

async function run033Writer(title: string, content: string): Promise<void> {
	await runHistoricalWriter(v033StorageCommit, "0.3.3", title, content);
}

async function run040Writer(title: string, content: string): Promise<void> {
	await runHistoricalWriter(v040StorageCommit, "0.4.0", title, content);
}

describe("persistent memory storage compatibility", () => {
	it("round-trips a 0.3.3 writer without losing tiers or literal metadata-looking content", async () => {
		const literalBody = "<!-- memory-layer-tier:v1: note -->\nThis is ordinary memory text.";
		await saveMemory("user", undefined, "general", "General", "Tiered entry", literalBody, "log");

		await run033Writer("Written by 0.3.3", "The older writer must survive.");

		await expect(readMemoryMd("user")).resolves.not.toContain("memory-layer-index:v2");
		const rawTopic = await fs.readFile(path.join(testHome, ".pi", "memory", "user", "general.md"), "utf8");
		expect(rawTopic).toContain("<!-- @entry:");
		expect(rawTopic).not.toContain("memory-layer-entry:v2");

		expect(await loadTopicEntries("user", undefined, "general")).toEqual([
			{ title: "Tiered entry", content: literalBody, tier: "log" },
			{ title: "Written by 0.3.3", content: "The older writer must survive.", tier: "profile" },
		]);
	});

	it("restores sidecar tiers after an old 0.4.0 writer rewrites the topic as v2", async () => {
		await saveMemory("user", undefined, "general", "General", "Tiered entry", "tiered body", "log");

		await run040Writer("Written by 0.4.0", "The old v2 writer must remain readable.");

		const rawTopic = await fs.readFile(path.join(testHome, ".pi", "memory", "user", "general.md"), "utf8");
		expect(rawTopic).toContain("memory-layer-entry:v2");
		expect(await loadTopicEntries("user", undefined, "general")).toEqual([
			{ title: "Tiered entry", content: "tiered body", tier: "log" },
			{ title: "Written by 0.4.0", content: "The old v2 writer must remain readable.", tier: "profile" },
		]);
	});

	it("reads already-written v2 markers and rewrites them in the legacy-compatible format", async () => {
		const metadata = Buffer.from(JSON.stringify({ title: "Already written", tier: "note" }), "utf8").toString("base64");
		const memoryDir = path.join(testHome, ".pi", "memory", "user");
		await fs.mkdir(memoryDir, { recursive: true });
		await fs.writeFile(
			path.join(memoryDir, "general.md"),
			`# General\n\n<!-- memory-layer-entry:v2: ${metadata} -->\nold v2 body\n`,
			"utf8",
		);
		await fs.writeFile(
			path.join(memoryDir, "MEMORY.md"),
			"# Memory Index\n<!-- memory-layer-index:v2 -->\n\n## general.md\n- [note] Already written\n",
			"utf8",
		);

		await saveMemory("user", undefined, "general", "General", "New entry", "new body", "profile");

		expect(await loadTopicEntries("user", undefined, "general")).toEqual([
			{ title: "Already written", content: "old v2 body", tier: "note" },
			{ title: "New entry", content: "new body", tier: "profile" },
		]);
		await expect(readMemoryMd("user")).resolves.not.toContain("memory-layer-index:v2");
	});

	it("keeps persisted default memories visible when PI_CODING_AGENT_DIR explicitly names the default", async () => {
		await saveMemory("user", undefined, "general", "General", "Default memory", "default body");
		const defaultPath = path.join(testHome, ".pi", "memory", "user", "general.md");
		await expect(fs.access(defaultPath)).resolves.toBeUndefined();

		const explicitDefaultAgentDir = path.join(testHome, ".pi", "agent", "..", "agent");
		vi.stubEnv("PI_CODING_AGENT_DIR", explicitDefaultAgentDir);
		await saveMemory("user", undefined, "general", "General", "Explicit default memory", "explicit default body");

		await expect(fs.access(defaultPath)).resolves.toBeUndefined();
		await expect(fs.access(path.join(testHome, ".pi", "agent", "memory", "user", "general.md"))).rejects.toThrow();
		expect(await loadTopicEntries("user", undefined, "general")).toEqual([
			{ title: "Default memory", content: "default body", tier: "profile" },
			{ title: "Explicit default memory", content: "explicit default body", tier: "profile" },
		]);

		const agentDir = path.join(testHome, "custom-agent");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		await saveMemory("user", undefined, "general", "General", "Isolated memory", "isolated body");

		await expect(fs.access(path.join(agentDir, "memory", "user", "general.md"))).resolves.toBeUndefined();
		expect(await loadTopicEntries("user", undefined, "general")).toEqual([
			{ title: "Isolated memory", content: "isolated body", tier: "profile" },
		]);

		vi.stubEnv("PI_CODING_AGENT_DIR", "");
		expect(await loadTopicEntries("user", undefined, "general")).toEqual([
			{ title: "Default memory", content: "default body", tier: "profile" },
			{ title: "Explicit default memory", content: "explicit default body", tier: "profile" },
		]);
	});
});
