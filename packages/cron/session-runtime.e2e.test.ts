/** biome-ignore-all lint/suspicious/noExplicitAny: RPC frames are runtime protocol fixtures. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { upsertJob, writePromptFile } from "./store.ts";
import type { CronJob, CronStoreFile } from "./types.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));
const piBinary = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).stdout?.trim();

async function waitFor<T>(check: () => T | undefined, diagnostic: () => string, timeout = 20_000): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = check();
		if (value !== undefined) return value;
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	throw new Error(`Timed out: ${diagnostic()}`);
}

async function stop(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveStop) => {
		const force = setTimeout(() => child.kill("SIGKILL"), 1000);
		child.once("close", () => {
			clearTimeout(force);
			resolveStop();
		});
		child.kill("SIGTERM");
	});
}

const offlineProvider = `
import { createAssistantMessageEventStream } from ${JSON.stringify(resolve(packageDir, "../../node_modules/@earendil-works/pi-ai/dist/index.js"))};
export default function (pi) {
  pi.registerProvider("cron-smoke", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline", api: "cron-smoke-api",
    models: [{ id: "deterministic", name: "Offline test model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const user = [...context.messages].reverse().find(m => m.role === "user");
      const userText = JSON.stringify(user?.content ?? "");
      const marker = userText.match(/SMOKE_(SEED|CLOSED|LIVE|BUSY)/)?.[0] ?? "UNKNOWN";
      let content;
      let stopReason = "stop";
      if (last?.role === "user" && marker !== "SMOKE_BUSY") {
        stopReason = "toolUse";
        content = [{ type: "toolCall", id: "test-" + marker, name: marker === "SMOKE_SEED" ? "remember" : "recall",
          arguments: marker === "SMOKE_SEED"
            ? { scope: "agent", tier: "log", title: "rpc sentinel", content: "SENTINEL_VALUE" }
            : { scope: "agent", tier: "log", query: "rpc sentinel" } }];
      } else {
        const memory = JSON.stringify(last?.content ?? "").includes("SENTINEL_VALUE");
        const history = JSON.stringify(context.messages).includes("SMOKE_SEED");
        content = [{ type: "text", text: "SMOKE_DONE " + marker + " history=" + history + " memory=" + memory }];
      }
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      setTimeout(() => {
        stream.push({ type: "done", reason: stopReason, message });
        stream.end();
      }, marker === "SMOKE_BUSY" ? 700 : 5);
      return stream;
    }
  });
}
`;

(piBinary ? it : it.skip)(
	"preserves same-session memory and cron delivery across busy turns, reload, and slow shutdown",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "cron-real-rpc-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(root, "home"), { recursive: true });
		const provider = join(root, "provider.ts");
		const commandMarker = join(root, "cron-command-marker");
		const deliveriesPath = join(root, "command-deliveries.jsonl");
		const shutdownGate = join(root, "hold-shutdown");
		const shutdownEntered = join(root, "shutdown-entered");
		const commandExtension = join(root, "cron-command.mjs");
		writeFileSync(provider, offlineProvider);
		writeFileSync(
			commandExtension,
			`import { appendFileSync, existsSync, writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("cron-probe", { description: "offline cron probe", handler: async (args) => {
    writeFileSync(${JSON.stringify(commandMarker)}, "handled");
    appendFileSync(${JSON.stringify(deliveriesPath)}, JSON.stringify({ args, pid: process.pid }) + "\\n");
  } });
  pi.registerCommand("cron-reload", { description: "offline reload probe", handler: async (_args, ctx) => ctx.reload() });
  pi.on("session_shutdown", async (event) => {
    if (!existsSync(${JSON.stringify(shutdownGate)})) return;
    writeFileSync(${JSON.stringify(shutdownEntered)}, event.reason);
    const deadline = Date.now() + 15000;
    while (existsSync(${JSON.stringify(shutdownGate)})) {
      if (Date.now() > deadline) throw new Error("test shutdown gate timed out");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  });
}`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [],
				extensions: [
					join(packageDir, "index.ts"),
					resolve(packageDir, "../memory-layer/index.ts"),
					provider,
					commandExtension,
				],
				defaultProvider: "cron-smoke",
				defaultModel: "deterministic",
				autoCompaction: { enabled: false },
			}),
		);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: join(root, "home"),
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_CRON_PI_BIN: piBinary,
			PI_CRON_TICK_INTERVAL_MS: "50",
			PI_CRON_JOB_TIMEOUT_MS: "15000",
			PI_CRON_JOB_KILL_GRACE_MS: "1000",
		};
		delete env.PI_CRON_SESSION_RESERVATION;
		const children: ChildProcess[] = [];
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		let daemonOutput = "";
		function startRpc(sessionFile?: string) {
			const child = spawn(
				piBinary,
				["--mode", "rpc", "--offline", ...(sessionFile ? ["--session", sessionFile] : [])],
				{
					cwd,
					env,
					stdio: "pipe",
				},
			);
			children.push(child);
			const events: any[] = [];
			let buffer = "";
			let stderr = "";
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					try {
						events.push(JSON.parse(line));
					} catch {
						stderr += line;
					}
					newline = buffer.indexOf("\n");
				}
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			let nextId = 0;
			return {
				child,
				events,
				diagnostic: () => `${stderr}\n${JSON.stringify(events.slice(-5))}`,
				async request(type: string, fields: Record<string, unknown> = {}) {
					const id = `smoke-${++nextId}`;
					child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
					const response = await waitFor(
						() => events.find((event) => event.type === "response" && event.id === id),
						() => `${stderr}\n${JSON.stringify(events.slice(-5))}`,
					);
					expect(response.success, JSON.stringify(response)).toBe(true);
					return response.data;
				},
			};
		}
		const storePath = join(agentDir, "cron", "jobs.json");
		function readStore(): CronStoreFile {
			return existsSync(storePath)
				? JSON.parse(readFileSync(storePath, "utf8"))
				: { version: 2, jobs: [], history: [] };
		}
		try {
			const seed = startRpc();
			await seed.request("prompt", { message: "SMOKE_SEED" });
			await waitFor(() => seed.events.find((event) => event.type === "agent_settled"), seed.diagnostic);
			const state = await seed.request("get_state");
			const sessionId = state.sessionId as string;
			const sessionFile = state.sessionFile as string;
			const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
			const ownerPath = join(agentDir, "cron", "sessions", `${key}.json`);
			expect(readFileSync(sessionFile, "utf8")).toContain("memory-layer-agent");
			expect(existsSync(ownerPath)).toBe(true);
			await stop(seed.child);

			function enqueue(id: string, prompt: string) {
				const now = new Date().toISOString();
				const promptFile = writePromptFile(id, prompt);
				const job: CronJob = {
					id,
					name: id,
					scope: "session",
					sessionId,
					sessionFile,
					cwd,
					promptFile,
					enabled: true,
					kind: "at",
					once: true,
					runAt: now,
					timezone: "UTC",
					createdAt: now,
					updatedAt: now,
				};
				upsertJob(job);
			}
			enqueue("closed", "SMOKE_CLOSED");
			const daemon = spawn(process.execPath, [join(packageDir, "daemon.mjs")], { cwd, env, stdio: "pipe" });
			children.push(daemon);
			daemon.stderr?.on("data", (chunk) => {
				daemonOutput += chunk.toString();
			});
			const daemonLog = () => readFileSync(join(agentDir, "cron", "daemon.log"), "utf8");
			const diagnostics = () => `${daemonOutput}\n${daemonLog()}\n${JSON.stringify(readStore())}`;
			const closed = await waitFor(() => readStore().history.find((job) => job.id === "closed"), diagnostics);
			expect(closed.lastDeliveryOutcome, JSON.stringify(closed)).toBe("settled");
			expect(readFileSync(sessionFile, "utf8")).toContain("SMOKE_DONE SMOKE_CLOSED history=true memory=true");

			enqueue("closed-command", "/cron-probe");
			const closedCommand = await waitFor(
				() => readStore().history.find((job) => job.id === "closed-command"),
				diagnostics,
			);
			expect(closedCommand.lastDeliveryOutcome, JSON.stringify(closedCommand)).toBe("settled");
			expect(readFileSync(commandMarker, "utf8")).toBe("handled");

			const live = startRpc(sessionFile);
			await live.request("get_state");
			const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
			expect(owner.pid).toBe(live.child.pid);
			await live.request("prompt", { message: "SMOKE_BUSY" });
			enqueue("live", "SMOKE_LIVE");
			const delivered = await waitFor(() => readStore().history.find((job) => job.id === "live"), diagnostics);
			expect(delivered.lastDeliveryOutcome).toBe("queued");
			await waitFor(
				() =>
					readFileSync(sessionFile, "utf8").includes("SMOKE_DONE SMOKE_LIVE history=true memory=true")
						? true
						: undefined,
				live.diagnostic,
			);
			expect(JSON.parse(readFileSync(ownerPath, "utf8")).generation).toBe(owner.generation);
			expect(live.child.exitCode).toBeNull();
			expect(JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]).id).toBe(sessionId);

			function commandDeliveries(args: string): { args: string; pid: number }[] {
				return readFileSync(deliveriesPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
					.filter((delivery) => delivery.args === args);
			}
			async function expectDeferredDuringShutdown(id: string, reason: string) {
				await waitFor(
					() => (existsSync(shutdownEntered) && readFileSync(shutdownEntered, "utf8") === reason ? true : undefined),
					live.diagnostic,
				);
				enqueue(id, `/cron-probe ${id}`);
				// Wait for the daemon to encounter the blocked job, not merely for time to pass.
				await waitFor(
					() =>
						daemonLog()
							.split("\n")
							.some((line) => line.includes("session delivery deferred") && line.includes(id))
							? true
							: undefined,
					diagnostics,
				);
				expect(readStore().jobs.find((job) => job.id === id)).toMatchObject({ enabled: true });
				expect(readStore().history.find((job) => job.id === id)).toBeUndefined();
				expect(commandDeliveries(id)).toEqual([]);
				expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toMatchObject({ pid: live.child.pid, state: "draining" });
				expect(live.child.exitCode).toBeNull();
			}

			writeFileSync(shutdownGate, "reload");
			const reload = live.request("prompt", { message: "/cron-reload" });
			void reload.catch(() => {});
			await expectDeferredDuringShutdown("after-reload", "reload");
			rmSync(shutdownGate);
			await reload;
			const afterReload = await waitFor(
				() => readStore().history.find((job) => job.id === "after-reload"),
				diagnostics,
			);
			expect(afterReload.lastDeliveryOutcome, JSON.stringify(afterReload)).toBe("queued");
			await waitFor(() => (commandDeliveries("after-reload").length ? true : undefined), live.diagnostic);
			expect(commandDeliveries("after-reload")).toEqual([{ args: "after-reload", pid: live.child.pid }]);
			const reloadedOwner = JSON.parse(readFileSync(ownerPath, "utf8"));
			expect(reloadedOwner).toMatchObject({ pid: live.child.pid, state: "active" });
			expect(reloadedOwner.generation).not.toBe(owner.generation);

			rmSync(shutdownEntered);
			writeFileSync(shutdownGate, "quit");
			live.child.kill("SIGTERM");
			await expectDeferredDuringShutdown("after-quit", "quit");
			rmSync(shutdownGate);
			await waitFor(
				() => (live.child.exitCode !== null || live.child.signalCode !== null ? true : undefined),
				live.diagnostic,
			);
			const afterQuit = await waitFor(() => readStore().history.find((job) => job.id === "after-quit"), diagnostics);
			expect(afterQuit.lastDeliveryOutcome, JSON.stringify(afterQuit)).toBe("settled");
			expect(commandDeliveries("after-quit")).toHaveLength(1);
			expect(commandDeliveries("after-quit")[0].pid).not.toBe(live.child.pid);
			expect(JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]).id).toBe(sessionId);
		} finally {
			rmSync(shutdownGate, { force: true });
			for (const child of children.reverse()) await stop(child);
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	},
	60_000,
);
