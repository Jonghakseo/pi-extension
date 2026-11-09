import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CronJob, CronStoreFile } from "./types.ts";

// The daemon holds a due job while the Mac has no Wi-Fi or Ethernet; these tests run jobs whether or not it is online.
process.env.PI_CRON_NETWORK_CHECK = "off";

const cronDirname = dirname(fileURLToPath(import.meta.url));
const agentDir = resolve(cronDirname, "..", "..");
const extensionPath = resolve(cronDirname, "index.ts");

function hasPiBinary(): boolean {
	return spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf-8" }).status === 0;
}

const piBinary = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf-8" }).stdout?.trim();

// Real Pi writes the transcript; only the model is replaced so the run stays offline and its usage is known.
const usageProvider = `
import { createAssistantMessageEventStream } from ${JSON.stringify(resolve(cronDirname, "../../node_modules/@earendil-works/pi-ai/dist/index.js"))};
export default function (pi) {
  pi.registerProvider("cron-usage", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline", api: "cron-usage-api",
    models: [{ id: "deterministic", name: "Offline usage model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "CRON_USAGE_OK" }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      setTimeout(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      }, 5);
      return stream;
    }
  });
}
`;

async function waitFor<T>(check: () => T | undefined, diagnostic: () => string, timeout = 20_000): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = check();
		if (value !== undefined) return value;
		await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	}
	throw new Error(`Timed out: ${diagnostic()}`);
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

	(piBinary ? it : it.skip)(
		"keeps the Pi transcript with token usage next to the run log of a user scope job",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-cron-transcript-"));
			const tempAgentDir = join(root, "agent");
			const cwd = join(root, "workspace");
			const promptFile = join(tempAgentDir, "cron", "prompts", "usage-job.md");
			mkdirSync(dirname(promptFile), { recursive: true });
			mkdirSync(cwd, { recursive: true });
			mkdirSync(join(root, "home"), { recursive: true });
			const provider = join(root, "provider.mjs");
			writeFileSync(provider, usageProvider);
			writeFileSync(
				join(tempAgentDir, "settings.json"),
				JSON.stringify({
					packages: [],
					extensions: [provider],
					defaultProvider: "cron-usage",
					defaultModel: "deterministic",
					autoCompaction: { enabled: false },
				}),
			);
			writeFileSync(promptFile, "Report usage from cron\n");
			const now = new Date().toISOString();
			const job: CronJob = {
				id: "usage-job",
				name: "usage-job",
				scope: "user",
				enabled: true,
				kind: "at",
				once: true,
				runAt: now,
				timezone: "UTC",
				cwd,
				promptFile,
				createdAt: now,
				updatedAt: now,
			};
			const storePath = join(tempAgentDir, "cron", "jobs.json");
			writeFileSync(storePath, JSON.stringify({ version: 2, jobs: [job], history: [] }));
			const readStore = (): CronStoreFile => JSON.parse(readFileSync(storePath, "utf8"));

			const env: NodeJS.ProcessEnv = {
				...process.env,
				HOME: join(root, "home"),
				PI_CODING_AGENT_DIR: tempAgentDir,
				PI_OFFLINE: "1",
				PI_CRON_PI_BIN: piBinary,
				PI_CRON_TICK_INTERVAL_MS: "50",
				PI_CRON_JOB_TIMEOUT_MS: "15000",
			};
			const daemon = spawn(process.execPath, [resolve(cronDirname, "daemon.mjs")], { cwd, env, stdio: "ignore" });
			try {
				const daemonLog = () => {
					const path = join(tempAgentDir, "cron", "daemon.log");
					return existsSync(path) ? readFileSync(path, "utf8") : "";
				};
				const finished = await waitFor(
					() => readStore().history.find((item) => item.id === "usage-job"),
					() => `${daemonLog()}\n${JSON.stringify(readStore())}`,
				);
				expect(finished.lastExitCode).toBe(0);
				const runLog = finished.lastRunLog as string;
				expect(runLog).toMatch(/cron\/runs\/usage-job\/[^/]+\.log$/);
				// stdout still goes to the run log unchanged.
				expect(readFileSync(runLog, "utf8")).toContain("## stdout\nCRON_USAGE_OK\n");

				const sessionPath = runLog.replace(/\.log$/, ".session.jsonl");
				expect(existsSync(sessionPath)).toBe(true);
				const entries = readFileSync(sessionPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				expect(entries[0]).toMatchObject({ type: "session" });
				const assistant = entries.find((entry) => entry.type === "message" && entry.message?.role === "assistant");
				expect(assistant).toMatchObject({
					id: expect.any(String),
					timestamp: expect.any(String),
					message: {
						provider: "cron-usage",
						model: "deterministic",
						usage: { input: 11, output: 7, totalTokens: 18 },
					},
				});
			} finally {
				daemon.kill("SIGTERM");
				await new Promise((resolveWait) => setTimeout(resolveWait, 200));
				rmSync(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
