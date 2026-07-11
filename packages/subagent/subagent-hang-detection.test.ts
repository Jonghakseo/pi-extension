/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HANG_TIMEOUT_MS } from "./constants.ts";
import { checkForHungRuns } from "./index.ts";
import { createStore } from "./store.ts";
import type { CommandRunState } from "./types.ts";

function makeRun(sessionFile: string, overrides: Partial<CommandRunState> = {}): CommandRunState {
	return {
		id: 1,
		agent: "worker",
		task: "task",
		status: "running",
		startedAt: Date.now() - HANG_TIMEOUT_MS - 10_000,
		elapsedMs: HANG_TIMEOUT_MS + 10_000,
		toolCalls: 0,
		lastLine: "running",
		turnCount: 0,
		lastActivityAt: Date.now() - HANG_TIMEOUT_MS - 1000,
		sessionFile,
		...overrides,
	};
}

describe("subagent hang detection with persisted session fallback", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does not auto-abort when the session file mtime shows recent activity", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-hang-"));
		const sessionFile = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(sessionFile, "{}\n", "utf8");
		const fresh = new Date();
		fs.utimesSync(sessionFile, fresh, fresh);

		const store = createStore();
		const run = makeRun(sessionFile);
		store.commandRuns.set(run.id, run);
		const pi = { sendMessage: vi.fn() } as any;

		checkForHungRuns(store, pi);

		expect(run.status).toBe("running");
		expect(run.lastActivityAt).toBeGreaterThan(Date.now() - 10_000);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("ignores stale terminal state that predates the current invocation", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-hang-"));
		const sessionFile = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				timestamp: Date.now(),
				message: {
					role: "assistant",
					stopReason: "stop",
					timestamp: Date.now(),
					content: [{ type: "text", text: "Old done" }],
				},
			})}\n${JSON.stringify({ type: "subagent_done", timestamp: Date.now(), exitCode: 0, stopReason: "stop", runtime: "pi" })}\n`,
			"utf8",
		);

		const stale = new Date(Date.now() - HANG_TIMEOUT_MS - 5000);
		fs.utimesSync(sessionFile, stale, stale);

		const store = createStore();
		const run = makeRun(sessionFile, { persistedSessionBaseOffset: fs.statSync(sessionFile).size });
		store.commandRuns.set(run.id, run);
		const pi = { sendMessage: vi.fn() } as any;

		checkForHungRuns(store, pi);

		expect(run.status).toBe("error");
		expect(run.lastLine).toContain("Auto-aborted");
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("marks the run done from the persisted terminal session state instead of auto-aborting", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-hang-"));
		const sessionFile = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				timestamp: Date.now(),
				message: {
					role: "assistant",
					stopReason: "stop",
					timestamp: Date.now(),
					content: [{ type: "text", text: "All done" }],
				},
			})}\n`,
			"utf8",
		);

		const store = createStore();
		const run = makeRun(sessionFile);
		store.commandRuns.set(run.id, run);
		const pi = { sendMessage: vi.fn() } as any;

		checkForHungRuns(store, pi);

		expect(run.status).toBe("done");
		expect(run.lastOutput).toBe("All done");
		expect(run.lastLine).toBe("All done");
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});
