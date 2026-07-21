import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPersistedTasks, type PersistedTask, savePersistedTasks } from "./storage.ts";

describe("delayed-action storage", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "delay-store-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const tasks: PersistedTask[] = [
		{ id: "delay-1", prompt: "확인해줘", createdAt: 1000, dueAt: 61000 },
		{ id: "deploy", prompt: "배포 로그", createdAt: 2000, dueAt: 3600000 },
	];

	it("returns empty when no store exists", async () => {
		expect(await loadPersistedTasks("session-x", dir)).toEqual([]);
	});

	it("round-trips tasks", async () => {
		await savePersistedTasks("session-1", tasks, dir);
		expect(await loadPersistedTasks("session-1", dir)).toEqual(tasks);
	});

	it("removes the store file when saving an empty list", async () => {
		await savePersistedTasks("session-1", tasks, dir);
		await savePersistedTasks("session-1", [], dir);
		expect(await loadPersistedTasks("session-1", dir)).toEqual([]);
	});

	it("ignores corrupted store contents", async () => {
		const target = path.join(dir, "session-1.json");
		await writeFile(target, "{ not json", "utf8");
		expect(await loadPersistedTasks("session-1", dir)).toEqual([]);
	});

	it("filters out malformed task entries", async () => {
		const target = path.join(dir, "session-1.json");
		await writeFile(
			target,
			JSON.stringify({ version: 1, sessionId: "session-1", tasks: [tasks[0], { id: 5 }, {}, null] }),
			"utf8",
		);
		expect(await loadPersistedTasks("session-1", dir)).toEqual([tasks[0]]);
	});

	it("keeps different sessions isolated", async () => {
		await savePersistedTasks("session-a", [tasks[0]], dir);
		await savePersistedTasks("session-b", [tasks[1]], dir);
		expect(await loadPersistedTasks("session-a", dir)).toEqual([tasks[0]]);
		expect(await loadPersistedTasks("session-b", dir)).toEqual([tasks[1]]);
	});

	it("sanitizes unsafe session ids and confines the file to the store dir", async () => {
		await savePersistedTasks("../../etc/passwd", [tasks[0]], dir);
		const files = await readdir(dir);
		expect(files).toHaveLength(1);
		expect(files[0].endsWith(".json")).toBe(true);
		expect(files[0].includes("/")).toBe(false);
		expect(await loadPersistedTasks("../../etc/passwd", dir)).toEqual([tasks[0]]);
	});
});
