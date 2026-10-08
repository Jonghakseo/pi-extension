/**
 * Proof of concept against a real Pi RPC child process, the real bash-async extension, and a fake
 * provider. No network, no user configuration: the child runs with an exact environment and a
 * throwaway HOME.
 *
 * Run it alone with:
 *   pnpm exec vitest run packages/task/runtime/poc.test.ts
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskReport, TaskWorker } from "../types.js";
import { isAlive, type Marker, parseMarkers, waitForFile, waitForMarker } from "./fixtures/observe.js";
import { createRpcWorker } from "./rpc-worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const fakeProvider = join(here, "fixtures", "fake-provider.ts");
const fakeDelegation = join(here, "fixtures", "fake-delegation-tool.ts");
const bashAsync = join(repoRoot, "packages", "bash-async", "index.ts");

const selection = (model: string, thinking: "off" | "low" = "off") => ({ provider: "task-fake", model, thinking });

interface Harness {
	worker: TaskWorker;
	root: string;
	markers: string;
	jobLog(name: string): string;
	delegationMarker: string;
	reports: TaskReport[];
	activity: string[];
	exits: Array<string | undefined>;
	errors: string[];
}

let active: Harness | undefined;

afterEach(async () => {
	const harness = active;
	active = undefined;
	if (!harness) return;
	await harness.worker.stop().catch(() => {});
	// PI_TASK_POC_KEEP leaves the child's markers, logs, and session behind for inspection.
	if (!process.env.PI_TASK_POC_KEEP) await rm(harness.root, { recursive: true, force: true });
});

async function createHarness(options: { readonly?: boolean } = {}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "task-poc-"));
	const home = join(root, "home");
	const work = join(root, "work");
	const agentDir = join(root, "agent");
	const markers = join(root, "markers.jsonl");
	const contextFile = join(root, "context.json");
	const delegationMarker = join(root, "delegated.txt");
	await Promise.all(
		[home, work, agentDir, join(root, "sessions"), join(root, "tmp")].map((dir) => mkdir(dir, { recursive: true })),
	);
	await writeFile(markers, "");
	await writeFile(contextFile, JSON.stringify({ brief: "poc brief", entries: [] }));

	const reports: TaskReport[] = [];
	const activity: string[] = [];
	const exits: Array<string | undefined> = [];
	const errors: string[] = [];
	const worker = createRpcWorker(
		{
			taskId: "task-poc",
			cwd: work,
			sessionFile: join(root, "sessions", "poc.jsonl"),
			contextFile,
			readonly: options.readonly ?? false,
			requestTimeoutMs: 45_000,
			env: {
				HOME: home,
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				TMPDIR: join(root, "tmp"),
				PI_CODING_AGENT_DIR: agentDir,
				PI_BASH_ASYNC_SYNC_WINDOW_MS: "0",
				PI_TASK_TEST_MARKERS: markers,
				PI_TASK_TEST_DELEGATION: delegationMarker,
				NO_COLOR: "1",
			},
			extraArgs: [
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-mcp",
				"--no-context-files",
				"--extension",
				fakeProvider,
				"--extension",
				fakeDelegation,
				"--extension",
				bashAsync,
				"--tools",
				"+bash_async",
			],
		},
		{
			onReport: (report) => reports.push(report),
			onActivity: (state) => activity.push(state),
			onExit: (error) => exits.push(error),
			onError: (error) => errors.push(error),
		},
	);
	const harness: Harness = {
		worker,
		root,
		markers,
		jobLog: (name: string) => join(root, `${name}.log`),
		delegationMarker,
		reports,
		activity,
		exits,
		errors,
	};
	active = harness;
	return harness;
}

function pidFrom(text: string): number {
	const match = /PID=(\d+)/.exec(text);
	if (!match) throw new Error(`No PID in job log: ${text}`);
	return Number(match[1]);
}

const isReportResult = (marker: Marker, failed: boolean): boolean =>
	marker.toolResult?.name === "task_report" && marker.toolResult.isError === failed;

it("keeps one RPC process across edits, background jobs, and a validated report", async () => {
	const harness = await createHarness();
	const jobA = harness.jobLog("job-a");

	// 1. A turn that leaves a background job running settles without finishing the Task.
	await harness.worker.start({
		revision: 1,
		prompt: `Task poc revision 1. CMD:START_JOB ${jobA} 3`,
		selection: selection("mock-a"),
	});
	await waitForMarker(harness.markers, (marker) => marker.verb === "START_JOB" && marker.model === "mock-a");
	const jobPid = pidFrom(await waitForFile(jobA, (text) => text.includes("PID=")));
	await waitForFile(harness.markers, (text) => text.includes("DONE:START_JOB"));
	expect(harness.activity).toContain("waiting");
	expect(harness.reports).toEqual([]);
	expect(isAlive(jobPid)).toBe(true);

	// 2. Delegation is blocked, and the blocked call never reaches the tool.
	await harness.worker.update({
		revision: 1,
		prompt: "CMD:DELEGATE now",
		selection: selection("mock-a"),
	});
	const blocked = await waitForMarker(harness.markers, (marker) => marker.toolResult?.name === "subagent");
	expect(blocked.toolResult?.isError).toBe(true);
	expect(existsSync(harness.delegationMarker)).toBe(false);

	// 3. Aborting interrupts a model run in flight, not the process and not the job.
	await harness.worker.update({ revision: 1, prompt: "CMD:BLOCK", selection: selection("mock-a") });
	await waitForMarker(harness.markers, (marker) => marker.verb === "BLOCK");
	await harness.worker.abort();
	expect(isAlive(jobPid)).toBe(true);
	expect(harness.exits).toEqual([]);

	// 4. An edit switches model and revision; a report for the old revision is refused.
	await harness.worker.update({
		revision: 2,
		prompt: "Revised instructions. CMD:REPORT 1 success",
		selection: selection("mock-b", "low"),
	});
	const stale = await waitForMarker(harness.markers, (marker) => isReportResult(marker, true));
	expect(stale.model).toBe("mock-b");
	expect(stale.toolResult?.text ?? "").toMatch(/revision/i);
	expect(harness.reports).toEqual([]);
	expect(isAlive(jobPid)).toBe(true);

	// 5. The detached job completes on its own and wakes the child.
	await waitForFile(jobA, (text) => text.includes("JOB_DONE"));
	await waitForMarker(harness.markers, (marker) => marker.kind === "completion");

	// 6. A second job proves the child owns its background work until shutdown.
	const jobB = harness.jobLog("job-b");
	await harness.worker.update({
		revision: 3,
		prompt: `CMD:START_JOB ${jobB} 120`,
		selection: selection("mock-b", "low"),
	});
	const longPid = pidFrom(await waitForFile(jobB, (text) => text.includes("PID=")));

	// 7. Only an explicit task_report for the active revision finishes it, exactly once.
	await harness.worker.update({ revision: 3, prompt: "CMD:REPORT 3 success", selection: selection("mock-b", "low") });
	await waitForMarker(harness.markers, (marker) => isReportResult(marker, false));
	expect(harness.reports).toHaveLength(1);
	expect(harness.reports[0]).toMatchObject({ taskId: "task-poc", revision: 3, status: "success" });
	await harness.worker.update({ revision: 3, prompt: "CMD:REPORT 3 success", selection: selection("mock-b", "low") });
	await waitForFile(
		harness.markers,
		(text) => parseMarkers(text).filter((marker) => isReportResult(marker, false)).length >= 2,
	);
	expect(harness.reports).toHaveLength(1);

	// 8. A planned stop is not an exit error, and the child cleans up its own jobs.
	await harness.worker.stop();
	expect(harness.exits).toEqual([]);
	expect(isAlive(longPid)).toBe(false);
	expect(harness.errors).toEqual([]);
	await expect(
		harness.worker.update({ revision: 4, prompt: "CMD:ECHO x", selection: selection("mock-b") }),
	).rejects.toThrow();
}, 120_000);

it("surfaces a terminal provider failure instead of waiting for task_report forever", async () => {
	const harness = await createHarness();
	await harness.worker.start({ revision: 1, prompt: "CMD:FAIL", selection: selection("mock-a") });
	await vi.waitFor(() => expect(harness.errors).toContain("Deliberate non-retryable provider failure"), {
		timeout: 20_000,
	});
	expect(harness.reports).toEqual([]);
}, 60_000);

it("refuses to run a Task on a model the child does not have", async () => {
	const harness = await createHarness();
	await expect(
		harness.worker.start({ revision: 1, prompt: "CMD:ECHO x", selection: selection("mock-zzz") }),
	).rejects.toThrow(/Model not found/);
	expect(harness.reports).toEqual([]);
}, 60_000);

it("reports an unexpected child exit instead of waiting forever", async () => {
	const harness = await createHarness();
	const worker = createRpcWorker(
		{
			taskId: "task-poc-exit",
			cwd: harness.root,
			sessionFile: join(harness.root, "sessions", "exit.jsonl"),
			contextFile: join(harness.root, "context.json"),
			readonly: false,
			requestTimeoutMs: 30_000,
			env: { HOME: join(harness.root, "home"), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, NO_COLOR: "1" },
			extraArgs: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--model", "not-a-real-model"],
		},
		{
			onReport: () => {},
			onActivity: () => {},
			onExit: (error) => harness.exits.push(error),
			onError: (error) => harness.errors.push(error),
		},
	);
	await expect(worker.start({ revision: 1, prompt: "x", selection: selection("mock-a") })).rejects.toThrow(
		/Task worker/,
	);
	expect(harness.exits).toHaveLength(1);
	expect(harness.exits[0] ?? "").toMatch(/not-a-real-model|exit code|signal/);
	await worker.stop();
}, 60_000);

it("fails visibly when the pi CLI cannot be used", async () => {
	const worker = createRpcWorker(
		{
			taskId: "task-missing-cli",
			cwd: tmpdir(),
			sessionFile: join(tmpdir(), "task-missing-cli.jsonl"),
			contextFile: join(tmpdir(), "task-missing-cli.json"),
			readonly: false,
			cliPath: join(tmpdir(), "definitely-not-a-pi-cli.js"),
		},
		{ onReport: () => {}, onActivity: () => {}, onExit: () => {}, onError: () => {} },
	);
	await expect(worker.start({ revision: 1, prompt: "x", selection: selection("mock-a") })).rejects.toThrow(
		/CLI not found/,
	);
	await worker.stop();
});
