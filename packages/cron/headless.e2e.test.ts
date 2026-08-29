import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cronDirname = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(cronDirname, "..", "..");
const extensionPath = resolve(cronDirname, "index.ts");

function hasPiBinary(): boolean {
	return spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf-8" }).status === 0;
}

describe("cron extension headless pi load", () => {
	const maybeIt = hasPiBinary() ? it : it.skip;

	maybeIt("loads in pi headless offline mode without starting an agent turn", () => {
		const tempAgentDir = join(tmpdir(), `pi-cron-headless-${process.pid}-${Date.now()}-${Math.random()}`);
		const result = spawnSync("pi", ["-p", "--no-session", "--no-tools", "--offline", "-e", extensionPath], {
			cwd: agentDir,
			encoding: "utf-8",
			timeout: 20_000,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempAgentDir,
				PI_OFFLINE: "1",
			},
		});
		rmSync(tempAgentDir, { recursive: true, force: true });

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});
