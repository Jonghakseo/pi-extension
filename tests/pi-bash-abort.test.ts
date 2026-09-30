import { execFileSync } from "node:child_process";
import { describe, it } from "vitest";

describe("Pi local shell cancellation", () => {
	it("does not start a shell when aborted during the cwd check", () => {
		// Run in a separate process so native ESM bindings can be observed without affecting other tests.
		execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
			import assert from "node:assert/strict";
			import childProcess from "node:child_process";
			import { syncBuiltinESMExports } from "node:module";
			const originalSpawn = childProcess.spawn;
			let starts = 0;
			childProcess.spawn = (...args) => {
				starts++;
				return originalSpawn(...args);
			};
			syncBuiltinESMExports();
			const { createLocalBashOperations } = await import("@earendil-works/pi-coding-agent");
			const controller = new AbortController();
			const execution = createLocalBashOperations().exec("true", process.cwd(), {
				onData() {}, signal: controller.signal,
			});
			controller.abort();
			await assert.rejects(execution, /aborted/);
			assert.equal(starts, 0, "an aborted command must not start a shell");
		`,
			],
			{ cwd: process.cwd(), timeout: 10_000, stdio: "pipe" },
		);
	});
});
