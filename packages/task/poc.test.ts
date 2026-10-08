import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

type Event = Record<string, unknown>;
const object = (value: unknown): Event => (value && typeof value === "object" ? (value as Event) : {});
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

function rpc(process: ChildProcessWithoutNullStreams) {
	const events: Event[] = [];
	let buffer = "";
	let stderr = "";
	let sequence = 0;
	const listeners = new Set<() => void>();
	process.stdout.on("data", (chunk) => {
		buffer += String(chunk);
		while (true) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (line.trim()) events.push(JSON.parse(line));
		}
		for (const listener of listeners) listener();
	});
	process.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	process.on("exit", () => {
		for (const listener of listeners) listener();
	});
	const wait = (predicate: (event: Event) => boolean, from = 0): Promise<Event> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => finish(new Error(`RPC event timeout. ${stderr}\n${JSON.stringify(events.slice(-8))}`)),
				20000,
			);
			const finish = (error?: Error, event?: Event) => {
				clearTimeout(timer);
				listeners.delete(check);
				if (error) reject(error);
				else if (event) resolve(event);
			};
			const check = () => {
				const found = events.slice(from).find(predicate);
				if (found) finish(undefined, found);
				else if (process.exitCode !== null || process.signalCode) finish(new Error(`RPC exited: ${stderr}`));
			};
			listeners.add(check);
			check();
		});
	return {
		events,
		wait,
		async command(type: string, fields: Event = {}) {
			const id = `poc-${++sequence}`;
			const pending = wait((event) => event.type === "response" && event.id === id, events.length);
			process.stdin.write(`${JSON.stringify({ type, id, ...fields })}\n`);
			const response = await pending;
			expect(response.success, JSON.stringify(response)).toBe(true);
			return response.data;
		},
	};
}

async function waitForFile(root: string, filename: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let finished = false;
		const finish = (error?: Error, value?: string) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			watcher.close();
			if (error) reject(error);
			else resolve(value ?? "");
		};
		const check = async () => {
			try {
				const value = await readFile(path.join(root, filename), "utf8");
				if (value) finish(undefined, value);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") finish(error as Error);
			}
		};
		const watcher = watch(root, () => {
			void check();
		});
		const timer = setTimeout(() => finish(new Error(`Missing PoC marker: ${filename}`)), 15000);
		void check();
	});
}

it("PoC: real parent Task -> evaluator -> RPC worker -> bash_async -> edit -> task_report -> parent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "task-full-poc-"));
	let child: ChildProcessWithoutNullStreams | undefined;
	try {
		for (const directory of ["home", "agent", "work", "tmp"]) await mkdir(path.join(root, directory));
		const selection = (model: string) => ({ provider: "task-poc", model, thinking: "low" });
		await writeFile(
			path.join(root, "agent/settings.json"),
			JSON.stringify({
				extensions: [path.join(here, "fixtures/poc-provider.ts"), path.join(repo, "packages/bash-async/index.ts")],
				task: {
					evaluator: selection("evaluator"),
					presets: { fast: selection("worker-a"), balanced: selection("worker-b"), powerful: selection("worker-b") },
				},
			}),
		);
		const cli = fileURLToPath(new URL("cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
		child = spawn(
			process.execPath,
			[
				cli,
				"--mode",
				"rpc",
				"--session",
				path.join(root, "parent.jsonl"),
				"--no-skills",
				"--no-prompt-templates",
				"--no-mcp",
				"--extension",
				path.join(here, "index.ts"),
				"--provider",
				"task-poc",
				"--model",
				"parent",
			],
			{
				cwd: path.join(root, "work"),
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					HOME: path.join(root, "home"),
					PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
					PI_CODING_AGENT_DIR: path.join(root, "agent"),
					TMPDIR: path.join(root, "tmp"),
					PI_BASH_ASYNC_SYNC_WINDOW_MS: "0",
					TASK_POC_ROOT: root,
					NO_COLOR: "1",
				},
			},
		);
		const client = rpc(child);
		await client.command("get_state");
		await client.command("prompt", { message: "run-poc" });
		const acceptance = await client.wait((e) => e.type === "tool_execution_end" && e.toolName === "Task");
		expect(acceptance.isError, JSON.stringify(acceptance)).toBe(false);
		const task = object(object(object(acceptance.result).details).task);
		expect(task.status).toBe("queued");
		expect(task.readonly).toBe(true);
		await client.wait((e) => e.type === "agent_settled");
		const ready = JSON.parse(await waitForFile(root, "job-ready.json")) as { pid: number };
		process.kill(ready.pid, 0);
		const editStart = client.events.length;
		await client.command("prompt", { message: `edit-poc ${task.id}` });
		const edit = await client.wait((e) => e.type === "tool_execution_end" && e.toolName === "Task", editStart);
		expect(edit.isError, JSON.stringify(edit)).toBe(false);
		expect(object(object(object(edit.result).details).task).revision).toBe(2);
		const observed = JSON.parse(await waitForFile(root, "edit-observed.json"));
		expect(observed).toEqual({ revision: 2, model: "worker-b" });
		process.kill(ready.pid, 0); // edit did not kill the detached command.
		const completion = await client.wait(
			(e) => e.type === "message_end" && object(e.message).customType === "task-completion",
		);
		expect(object(object(completion.message).details)).toMatchObject({
			taskId: task.id,
			revision: 2,
			status: "success",
		});
		expect(String(object(completion.message).content)).toContain("ASYNC_POC_DONE");
		await client.wait(
			(e) =>
				e.type === "message_end" &&
				object(e.message).role === "assistant" &&
				JSON.stringify(object(e.message).content).includes("PARENT_REPORT_PROCESSED"),
		);
		expect(
			client.events.filter((e) => e.type === "message_end" && object(e.message).customType === "task-completion"),
		).toHaveLength(1);
		expect(await readFile(path.join(root, "job-done"), "utf8")).toBe("done");
	} finally {
		if (child && child.exitCode === null && !child.signalCode) {
			const process = child;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => process.kill("SIGKILL"), 8000);
				process.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
				process.stdin.end();
			});
		}
		await rm(root, { recursive: true, force: true });
	}
}, 60000);
