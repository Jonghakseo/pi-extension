/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight execution and notification mocks. */
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobLog } from "./job-log.js";
import { createBashAsyncOperations, DEFAULT_MAX_CLOSED_LOG_BYTES, JobManager } from "./job-manager.js";
import { clampOutputLines, validateBashAsyncParams, validateCwd } from "./tool-schema.js";
import { compareAndSetJobStatus, isTerminalJobStatus, type JobStatus, terminalStatusForCause } from "./types.js";

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 })),
	);
});

describe("bash_async parameter validation", () => {
	it("accepts each action with its required fields", () => {
		expect(validateBashAsyncParams({ action: "start", command: "pnpm test" })).toMatchObject({
			ok: true,
			value: { action: "start", timeoutSeconds: 1_800 },
		});
		expect(validateBashAsyncParams({ action: "status", jobId: "job-1" })).toMatchObject({
			ok: true,
			value: { action: "status", jobId: "job-1" },
		});
		expect(validateBashAsyncParams({ action: "output", jobId: "job-1", lines: 999 })).toMatchObject({
			ok: true,
			value: { lines: 200 },
		});
		expect(validateBashAsyncParams({ action: "kill", jobId: "job-1" })).toMatchObject({ ok: true });
		expect(validateBashAsyncParams({ action: "list" })).toMatchObject({ ok: true, value: { action: "list" } });
	});

	it("rejects invalid action combinations before job acceptance", () => {
		expect(validateBashAsyncParams({ action: "start" })).toMatchObject({ ok: false });
		expect(validateBashAsyncParams({ action: "start", command: "echo ok", jobId: "job-1" })).toMatchObject({
			ok: false,
		});
		expect(validateBashAsyncParams({ action: "status" })).toMatchObject({ ok: false });
		expect(validateBashAsyncParams({ action: "output", jobId: "job-1", command: "echo nope" })).toMatchObject({
			ok: false,
		});
		expect(validateBashAsyncParams({ action: "kill", jobId: "job-1", command: "echo nope" })).toMatchObject({
			ok: false,
		});
		expect(validateBashAsyncParams({ action: "list", command: "echo nope" })).toMatchObject({ ok: false });
		expect(validateBashAsyncParams({ action: "list", jobId: "job-1" })).toMatchObject({ ok: false });
		expect(validateBashAsyncParams({ action: "unknown" })).toMatchObject({ ok: false });
	});

	it("normalizes output bounds", () => {
		expect(clampOutputLines(undefined)).toBe(50);
		expect(clampOutputLines(-1)).toBe(1);
		expect(clampOutputLines(200.9)).toBe(200);
	});
});

describe("bash_async cwd validation", () => {
	it("rejects a missing path and regular file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-schema-"));
		tempDirectories.push(directory);
		const file = join(directory, "file.txt");
		await writeFile(file, "not a directory");

		await expect(validateCwd("missing", directory)).resolves.toMatchObject({ ok: false });
		await expect(validateCwd(file, directory)).resolves.toMatchObject({ ok: false });
	});

	it("resolves a relative directory and follows a symlinked directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-schema-"));
		tempDirectories.push(directory);
		const child = join(directory, "child");
		const linkedChild = join(directory, "linked-child");
		await mkdir(child);
		await symlink(child, linkedChild);

		await expect(validateCwd("child", directory)).resolves.toEqual({ ok: true, cwd: child });
		await expect(validateCwd("linked-child", directory)).resolves.toEqual({ ok: true, cwd: linkedChild });
	});
});

describe("bash_async job state transitions", () => {
	it("compare-and-sets valid states without mutating the source job", () => {
		const job: { id: string; status: JobStatus } = { id: "job-1", status: "queued" };
		const running = compareAndSetJobStatus(job, "queued", "running");

		expect(running).toEqual({ id: "job-1", status: "running" });
		expect(job).toEqual({ id: "job-1", status: "queued" });
		expect(compareAndSetJobStatus(job, "running", "succeeded")).toBeUndefined();
		expect(compareAndSetJobStatus(running ?? job, "running", "killed")).toMatchObject({ status: "killed" });
	});

	it("rejects terminal transitions and maps every terminal cause", () => {
		const finished: { status: JobStatus } = { status: "succeeded" };
		expect(compareAndSetJobStatus(finished, "succeeded", "failed")).toBeUndefined();
		expect(isTerminalJobStatus("queued")).toBe(false);
		expect(isTerminalJobStatus("shutdown")).toBe(true);
		expect(terminalStatusForCause("natural")).toBe("succeeded");
		expect(terminalStatusForCause("nonzero")).toBe("failed");
		expect(terminalStatusForCause("timeout")).toBe("timed_out");
		expect(terminalStatusForCause("kill")).toBe("killed");
		expect(terminalStatusForCause("shutdown")).toBe("shutdown");
		expect(terminalStatusForCause("spawn_error")).toBe("failed");
		expect(terminalStatusForCause("cleanup_error")).toBe("failed");
	});
});

function context(cwd: string, sessionId = "test-session"): any {
	return {
		cwd,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/tmp/test-session.jsonl" },
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("bash_async execution adapter", () => {
	it("writes output only to the bounded job log sink, not Pi's duplicate accumulator", async () => {
		const jobOutput = vi.fn();
		const piAccumulator = vi.fn();
		const baseOperations: any = {
			exec: async (_command: string, _cwd: string, options: any) => {
				options.onData(Buffer.alloc(64 * 1024, "x"));
				return { exitCode: 0 };
			},
		};
		const operations = createBashAsyncOperations(baseOperations, jobOutput);

		await operations.exec("produce output", "/tmp", { onData: piAccumulator });

		expect(jobOutput).toHaveBeenCalledOnce();
		expect(piAccumulator).not.toHaveBeenCalled();
	});
});

describe("JobManager state change callbacks", () => {
	it("reports acceptance, queued-to-running, and terminal transitions in order", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const executions = new Map<string, ReturnType<typeof deferred<{ exitCode: number | null }>>>();
		const states: Array<{ id: string; status: string }> = [];
		const manager = new JobManager({
			maxConcurrency: 1,
			logsDirectory: directory,
			onStateChange: (job) => states.push({ id: job.id, status: job.status }),
			execute: ({ job }) => {
				const execution = deferred<{ exitCode: number | null }>();
				executions.set(job.id, execution);
				return execution.promise;
			},
		});
		const first = await manager.start({ command: "first", timeoutSeconds: 0, context: context(directory) });
		const second = await manager.start({ command: "second", timeoutSeconds: 0, context: context(directory) });
		if (!first.ok || !second.ok) throw new Error("jobs not accepted");

		expect(states).toEqual([
			{ id: first.details.jobId, status: "queued" },
			{ id: first.details.jobId, status: "running" },
			{ id: second.details.jobId, status: "queued" },
		]);
		executions.get(first.details.jobId)?.resolve({ exitCode: 0 });
		await vi.waitFor(() =>
			expect(states).toEqual([
				{ id: first.details.jobId, status: "queued" },
				{ id: first.details.jobId, status: "running" },
				{ id: second.details.jobId, status: "queued" },
				{ id: first.details.jobId, status: "succeeded" },
				{ id: second.details.jobId, status: "running" },
			]),
		);
		executions.get(second.details.jobId)?.resolve({ exitCode: 0 });
	});

	it("reports cleanup-error quarantine and shutdown without allowing callback failures to disrupt jobs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const neverSettles = deferred<{ exitCode: number | null }>();
		const states: Array<{ status: string; terminalCause?: string }> = [];
		const manager = new JobManager({
			maxConcurrency: 1,
			logsDirectory: directory,
			onStateChange: (job) => {
				states.push({ status: job.status, terminalCause: job.terminalCause });
				throw new Error("UI callback failure");
			},
			execute: () => neverSettles.promise,
		});
		const started = await manager.start({ command: "never", timeoutSeconds: 0, context: context(directory) });
		if (!started.ok) throw new Error("job not accepted");
		await manager.kill(started.details.jobId, 1);
		expect(states.at(-1)).toEqual({ status: "failed", terminalCause: "cleanup_error" });

		const shutdownStates: string[] = [];
		const shutdownManager = new JobManager({
			maxConcurrency: 1,
			logsDirectory: join(directory, "shutdown"),
			onStateChange: (job) => shutdownStates.push(job.status),
			execute: () => new Promise<{ exitCode: number | null }>(() => {}),
		});
		await shutdownManager.start({ command: "running", timeoutSeconds: 0, context: context(directory) });
		await shutdownManager.start({ command: "queued", timeoutSeconds: 0, context: context(directory) });
		shutdownManager.beginShutdown();
		expect(shutdownStates).toContain("shutdown");
	});
});

describe("JobManager queue and lifecycle", () => {
	it("does not call the fifth operation before a FIFO slot opens", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const running = new Map<string, ReturnType<typeof deferred<{ exitCode: number | null }>>>();
		const started: string[] = [];
		const manager = new JobManager({
			maxConcurrency: 4,
			logsDirectory: directory,
			execute: ({ job }) => {
				started.push(job.command);
				const execution = deferred<{ exitCode: number | null }>();
				running.set(job.id, execution);
				return execution.promise;
			},
		});
		const jobs = [];
		for (let index = 0; index < 5; index++) {
			jobs.push(await manager.start({ command: `job-${index}`, timeoutSeconds: 0, context: context(directory) }));
		}
		expect(started).toEqual(["job-0", "job-1", "job-2", "job-3"]);
		expect(jobs[4]).toMatchObject({ ok: true, details: { status: "queued" } });

		const first = jobs[0];
		if (!first.ok) throw new Error("job did not start");
		running.get(first.details.jobId)?.resolve({ exitCode: 0 });
		await vi.waitFor(() => expect(started).toEqual(["job-0", "job-1", "job-2", "job-3", "job-4"]));
		for (const execution of running.values()) execution.resolve({ exitCode: 0 });
	});

	it("kills a queued job without spawning it and rejects starts after shutdown", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const execute = vi.fn(() => new Promise<{ exitCode: number | null }>(() => {}));
		const manager = new JobManager({ maxConcurrency: 1, logsDirectory: directory, execute });
		const first = await manager.start({ command: "first", timeoutSeconds: 0, context: context(directory) });
		const second = await manager.start({ command: "second", timeoutSeconds: 0, context: context(directory) });
		if (!first.ok || !second.ok) throw new Error("jobs not accepted");
		await manager.kill(second.details.jobId, 1);
		expect(manager.get(second.details.jobId)?.status).toBe("killed");
		expect(execute).toHaveBeenCalledTimes(1);
		manager.beginShutdown();
		await expect(
			manager.start({ command: "third", timeoutSeconds: 0, context: context(directory) }),
		).resolves.toMatchObject({ ok: false });
	});

	it("classifies a real nonzero command and timeout", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const manager = new JobManager({ logsDirectory: directory });
		const failed = await manager.start({ command: "exit 7", timeoutSeconds: 5, context: context(directory) });
		const timedOut = await manager.start({ command: "sleep 1", timeoutSeconds: 0.01, context: context(directory) });
		if (!failed.ok || !timedOut.ok) throw new Error("jobs not accepted");
		await vi.waitFor(() => expect(manager.get(failed.details.jobId)?.status).toBe("failed"));
		await vi.waitFor(() => expect(manager.get(timedOut.details.jobId)?.status).toBe("timed_out"));
		expect(manager.get(failed.details.jobId)?.exitCode).toBe(7);
	});
});

describe("JobManager real-process integration", () => {
	it("accepts quickly, captures incremental output, and preserves start-time PI metadata", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const manager = new JobManager({ logsDirectory: directory });
		const startedAt = performance.now();
		const started = await manager.start({
			command: "sleep 0.2; printf '%s\\n' \"$PI_SESSION_ID/$PI_PROVIDER/$PI_MODEL/$PI_REASONING_LEVEL\"",
			timeoutSeconds: 5,
			context: context(directory),
		});
		expect(performance.now() - startedAt).toBeLessThan(100);
		if (!started.ok) throw new Error("job not accepted");
		await vi.waitFor(() => expect(manager.get(started.details.jobId)?.status).toBe("succeeded"));
		expect(manager.output(started.details.jobId, { incremental: true })?.text).toContain(
			"test-session/test-provider/test-model/high",
		);
		expect(manager.output(started.details.jobId, { incremental: true })?.text).toBe("");
	});

	it("does not create Pi's duplicate unbounded output temp file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const duplicateTemp = join(directory, "pi-duplicate-temp");
		await mkdir(duplicateTemp);
		const previousTmpdir = process.env.TMPDIR;
		const hadTmpdir = Object.hasOwn(process.env, "TMPDIR");
		process.env.TMPDIR = duplicateTemp;
		try {
			const manager = new JobManager({ logsDirectory: join(directory, "bounded-logs") });
			const started = await manager.start({
				command: "python3 -c \"import sys; sys.stdout.write('x' * 65536)\"",
				timeoutSeconds: 5,
				context: context(directory),
			});
			if (!started.ok) throw new Error("job not accepted");
			await vi.waitFor(() => expect(manager.get(started.details.jobId)?.status).toBe("succeeded"));
			expect((await readdir(duplicateTemp)).filter((name) => name.startsWith("pi-bash-"))).toEqual([]);
		} finally {
			if (hadTmpdir) process.env.TMPDIR = previousTmpdir;
			else Reflect.deleteProperty(process.env, "TMPDIR");
		}
	});

	it("kills an ordinary shell child process tree", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const parentPidFile = join(directory, "parent.pid");
		const childPidFile = join(directory, "child.pid");
		const manager = new JobManager({ logsDirectory: directory });
		const command = `PARENT_PID_FILE=${JSON.stringify(parentPidFile)} CHILD_PID_FILE=${JSON.stringify(childPidFile)} sh -c 'echo $$ > "$PARENT_PID_FILE"; sleep 30 & echo $! > "$CHILD_PID_FILE"; wait'`;
		const started = await manager.start({ command, timeoutSeconds: 0, context: context(directory) });
		if (!started.ok) throw new Error("job not accepted");
		await vi.waitFor(async () => {
			expect(Number(await readFile(parentPidFile, "utf8"))).toBeGreaterThan(0);
			expect(Number(await readFile(childPidFile, "utf8"))).toBeGreaterThan(0);
		});
		const parentPid = Number(await readFile(parentPidFile, "utf8"));
		const childPid = Number(await readFile(childPidFile, "utf8"));
		try {
			expect((await manager.kill(started.details.jobId))?.status).toBe("killed");
			await vi.waitFor(() => {
				expect(isProcessAlive(parentPid)).toBe(false);
				expect(isProcessAlive(childPid)).toBe(false);
			});
		} finally {
			if (isProcessAlive(parentPid)) process.kill(parentPid, "SIGKILL");
			if (isProcessAlive(childPid)) process.kill(childPid, "SIGKILL");
		}
	});
});

describe("JobManager termination races", () => {
	it("uses the requested kill cause when kill races a natural exit", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const execution = deferred<{ exitCode: number | null }>();
		const manager = new JobManager({ logsDirectory: directory, execute: () => execution.promise });
		const started = await manager.start({ command: "race", timeoutSeconds: 0, context: context(directory) });
		if (!started.ok) throw new Error("job not accepted");
		const kill = manager.kill(started.details.jobId);
		execution.resolve({ exitCode: 0 });
		expect((await kill)?.status).toBe("killed");
	});

	it("uses explicit kill over a concurrent timeout and releases one slot once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const first = deferred<{ exitCode: number | null }>();
		const started: string[] = [];
		const manager = new JobManager({
			maxConcurrency: 1,
			logsDirectory: directory,
			execute: ({ job }) => {
				started.push(job.command);
				return job.command === "first" ? first.promise : Promise.resolve({ exitCode: 0 });
			},
		});
		const firstJob = await manager.start({ command: "first", timeoutSeconds: 0, context: context(directory) });
		const secondJob = await manager.start({ command: "second", timeoutSeconds: 0, context: context(directory) });
		if (!firstJob.ok || !secondJob.ok) throw new Error("jobs not accepted");
		const kill = manager.kill(firstJob.details.jobId);
		first.reject(new Error("timeout:1"));
		expect((await kill)?.status).toBe("killed");
		await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
	});

	it("suppresses completion delivery when shutdown races completion", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const execution = deferred<{ exitCode: number | null }>();
		const notifications = { enqueue: vi.fn(), suppress: vi.fn() };
		const manager = new JobManager({
			logsDirectory: directory,
			execute: () => execution.promise,
			notifications: notifications as any,
		});
		const started = await manager.start({ command: "finish", timeoutSeconds: 0, context: context(directory) });
		if (!started.ok) throw new Error("job not accepted");
		manager.beginShutdown();
		execution.resolve({ exitCode: 0 });
		await manager.abortAndSettleAll({ graceMs: 100 });
		expect(manager.get(started.details.jobId)?.status).toBe("shutdown");
		expect(notifications.suppress).toHaveBeenCalledOnce();
		expect(notifications.enqueue).not.toHaveBeenCalled();
	});
});

describe("JobManager capacity and settlement boundaries", () => {
	it("evicts the oldest recent terminal job before rejecting a new start", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const manager = new JobManager({
			logsDirectory: directory,
			execute: () => Promise.resolve({ exitCode: 0 }),
		});
		for (let index = 0; index < 20; index++) {
			const started = await manager.start({
				command: `completed-${index}`,
				timeoutSeconds: 0,
				context: context(directory),
			});
			if (!started.ok) throw new Error("job not accepted");
			await vi.waitFor(() => expect(manager.get(started.details.jobId)?.status).toBe("succeeded"));
		}
		const replacement = await manager.start({ command: "replacement", timeoutSeconds: 0, context: context(directory) });
		expect(replacement).toMatchObject({ ok: true });
		expect(manager.list()).toHaveLength(20);
	});

	it("never admits more than 20 parallel starts after cwd validation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const execution = deferred<{ exitCode: number | null }>();
		const manager = new JobManager({ logsDirectory: directory, execute: () => execution.promise });
		const results = await Promise.all(
			Array.from({ length: 21 }, (_, index) =>
				manager.start({ command: `parallel-${index}`, timeoutSeconds: 0, context: context(directory) }),
			),
		);
		expect(results.filter((result) => result.ok)).toHaveLength(20);
	});

	it("forces a terminal kill and releases the FIFO slot when settlement exceeds grace", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const execution = deferred<{ exitCode: number | null }>();
		const startedCommands: string[] = [];
		const manager = new JobManager({
			maxConcurrency: 1,
			logsDirectory: directory,
			execute: ({ job }) => {
				startedCommands.push(job.command);
				return job.command === "never-settles" ? execution.promise : Promise.resolve({ exitCode: 0 });
			},
		});
		const started = await manager.start({ command: "never-settles", timeoutSeconds: 0, context: context(directory) });
		const queued = await manager.start({ command: "next", timeoutSeconds: 0, context: context(directory) });
		if (!started.ok || !queued.ok) throw new Error("jobs not accepted");
		expect(await manager.kill(started.details.jobId, 1)).toMatchObject({
			status: "failed",
			terminalCause: "cleanup_error",
			errorSummary: expect.stringContaining("could not be confirmed"),
		});
		expect(startedCommands).toEqual(["never-settles"]);
		expect(manager.get(queued.details.jobId)?.status).toBe("queued");
		execution.resolve({ exitCode: 0 });
		await vi.waitFor(() => expect(startedCommands).toEqual(["never-settles", "next"]));
		await vi.waitFor(() => expect(manager.get(queued.details.jobId)?.status).toBe("succeeded"));
		expect(manager.get(started.details.jobId)?.status).toBe("failed");
	});

	it("contains asynchronous log write failures and fails only the affected job", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		let createdLog: JobLog | undefined;
		const manager = new JobManager({
			logsDirectory: directory,
			createLog: (path) => {
				createdLog = new JobLog({ path });
				vi.spyOn(createdLog, "append").mockImplementation(() => {
					throw new Error("ENOSPC fixture");
				});
				return createdLog;
			},
			execute: ({ onData }) =>
				new Promise((resolve) => {
					setTimeout(() => {
						onData(Buffer.from("output"));
						resolve({ exitCode: 0 });
					}, 0);
				}),
		});
		const started = await manager.start({ command: "log-failure", timeoutSeconds: 0, context: context(directory) });
		if (!started.ok) throw new Error("job not accepted");
		await vi.waitFor(() => expect(manager.get(started.details.jobId)?.status).toBe("failed"));
		expect(manager.get(started.details.jobId)?.errorSummary).toContain("log write failed: ENOSPC fixture");
		expect(createdLog?.summary().closed).toBe(true);
	});

	it("bounds a log failure whose aborted execution never settles and quarantines its slot", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const execution = deferred<{ exitCode: number | null }>();
		const startedCommands: string[] = [];
		const manager = new JobManager({
			maxConcurrency: 1,
			logsDirectory: directory,
			settlementGraceMs: 1,
			createLog: (path) => {
				const log = new JobLog({ path });
				vi.spyOn(log, "append").mockImplementation(() => {
					throw new Error("ENOSPC hanging fixture");
				});
				return log;
			},
			execute: ({ job, onData }) => {
				startedCommands.push(job.command);
				if (job.command === "log-hang") {
					onData(Buffer.from("output"));
					return execution.promise;
				}
				return Promise.resolve({ exitCode: 0 });
			},
		});
		const failed = await manager.start({ command: "log-hang", timeoutSeconds: 0, context: context(directory) });
		const queued = await manager.start({ command: "after-log-hang", timeoutSeconds: 0, context: context(directory) });
		if (!failed.ok || !queued.ok) throw new Error("jobs not accepted");
		await vi.waitFor(() =>
			expect(manager.get(failed.details.jobId)).toMatchObject({
				status: "failed",
				terminalCause: "cleanup_error",
			}),
		);
		expect(manager.get(queued.details.jobId)?.status).toBe("queued");
		expect(startedCommands).toEqual(["log-hang"]);
		execution.resolve({ exitCode: 0 });
		await vi.waitFor(() => expect(manager.get(queued.details.jobId)?.status).toBe("succeeded"));
		expect(startedCommands).toEqual(["log-hang", "after-log-hang"]);
	});

	it("does not accept a job when the turn aborts during cwd validation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const validation = deferred<{ ok: true; cwd: string }>();
		const execute = vi.fn(() => Promise.resolve({ exitCode: 0 }));
		const manager = new JobManager({ logsDirectory: directory, execute, validateCwd: () => validation.promise });
		const controller = new AbortController();
		const start = manager.start({
			command: "cancelled",
			timeoutSeconds: 0,
			context: context(directory),
			acceptanceSignal: controller.signal,
		});
		controller.abort();
		validation.resolve({ ok: true, cwd: directory });
		expect(await start).toMatchObject({ ok: false, error: expect.stringContaining("cancelled") });
		expect(execute).not.toHaveBeenCalled();
		expect(manager.list()).toEqual([]);
	});
});

describe("JobManager log retention", () => {
	it("does not recursively remove a session directory when cleanup races a new start", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-cleanup-race-"));
		tempDirectories.push(directory);
		const sessionDirectory = join(directory, "test-session");
		const staleLog = join(sessionDirectory, "stale.log");
		await mkdir(sessionDirectory, { recursive: true });
		await writeFile(staleLog, "stale");
		await writeFile(`${staleLog}.closed`, "");
		const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await utimes(staleLog, staleTime, staleTime);
		const cleanupReached = deferred<void>();
		const releaseCleanup = deferred<void>();
		const execution = deferred<{ exitCode: number | null }>();
		const manager = new JobManager({
			logsDirectory: directory,
			execute: () => execution.promise,
			onBeforeStaleLogRemove: async () => {
				cleanupReached.resolve();
				await releaseCleanup.promise;
			},
		});
		await cleanupReached.promise;
		const started = await manager.start({ command: "fresh", timeoutSeconds: 0, context: context(directory) });
		if (!started.ok) throw new Error("job not accepted");
		await access(started.details.logPath);
		releaseCleanup.resolve();
		await vi.waitFor(async () => expect(access(staleLog)).rejects.toMatchObject({ code: "ENOENT" }));
		await expect(access(started.details.logPath)).resolves.toBeUndefined();
		execution.resolve({ exitCode: 0 });
	});

	it("marks a nonempty quarantined log closed so another manager can prune it without touching an unmarked active log", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-quarantined-log-"));
		tempDirectories.push(directory);
		const neverSettles = deferred<{ exitCode: number | null }>();
		const firstManager = new JobManager({
			logsDirectory: directory,
			execute: ({ onData }) => {
				onData(Buffer.from("quarantined output"));
				return neverSettles.promise;
			},
		});
		const quarantined = await firstManager.start({
			command: "never-settles",
			timeoutSeconds: 0,
			context: context(directory, "quarantined-session"),
		});
		if (!quarantined.ok) throw new Error("job not accepted");
		await firstManager.kill(quarantined.details.jobId, 1);
		expect(firstManager.get(quarantined.details.jobId)).toMatchObject({
			status: "failed",
			terminalCause: "cleanup_error",
		});
		await vi.waitFor(() => expect(access(`${quarantined.details.logPath}.closed`)).resolves.toBeUndefined());

		const activeLogPath = join(directory, "active-session", "active.log");
		const activeLog = new JobLog({ path: activeLogPath });
		activeLog.append("active output");
		try {
			new JobManager({ logsDirectory: directory, maxClosedLogBytes: 0 });
			await vi.waitFor(async () =>
				expect(access(quarantined.details.logPath)).rejects.toMatchObject({ code: "ENOENT" }),
			);
			await expect(access(activeLogPath)).resolves.toBeUndefined();
			await expect(access(`${activeLogPath}.closed`)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			activeLog.close();
			neverSettles.resolve({ exitCode: 0 });
		}
	});

	it("prunes oldest closed logs to the injected global quota without deleting an active log", async () => {
		expect(DEFAULT_MAX_CLOSED_LOG_BYTES).toBe(1024 * 1024 * 1024);
		const directory = await mkdtemp(join(tmpdir(), "bash-async-log-quota-"));
		tempDirectories.push(directory);
		const activeExecution = deferred<{ exitCode: number | null }>();
		const manager = new JobManager({
			logsDirectory: directory,
			maxClosedLogBytes: 8,
			execute: ({ job, onData }) => {
				onData(Buffer.from("12345678"));
				return job.command === "active" ? activeExecution.promise : Promise.resolve({ exitCode: 0 });
			},
		});
		const active = await manager.start({
			command: "active",
			timeoutSeconds: 0,
			context: context(directory, "active-session"),
		});
		if (!active.ok) throw new Error("active job not accepted");
		const first = await manager.start({
			command: "first",
			timeoutSeconds: 0,
			context: context(directory, "first-session"),
		});
		if (!first.ok) throw new Error("first job not accepted");
		await vi.waitFor(() => expect(manager.get(first.details.jobId)?.status).toBe("succeeded"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		const second = await manager.start({
			command: "second",
			timeoutSeconds: 0,
			context: context(directory, "second-session"),
		});
		if (!second.ok) throw new Error("second job not accepted");
		await vi.waitFor(() => expect(manager.get(second.details.jobId)?.status).toBe("succeeded"));
		await vi.waitFor(async () => {
			expect(await closedLogBytes(directory)).toBeLessThanOrEqual(8);
			await expect(access(first.details.logPath)).rejects.toMatchObject({ code: "ENOENT" });
		});
		await expect(access(second.details.logPath)).resolves.toBeUndefined();
		await expect(access(active.details.logPath)).resolves.toBeUndefined();
		activeExecution.resolve({ exitCode: 0 });
	});
});

async function closedLogBytes(logsDirectory: string): Promise<number> {
	let bytes = 0;
	for (const session of await readdir(logsDirectory, { withFileTypes: true })) {
		if (!session.isDirectory()) continue;
		for (const entry of await readdir(join(logsDirectory, session.name), { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
			try {
				await access(join(logsDirectory, session.name, `${entry.name}.closed`));
				bytes += (await stat(join(logsDirectory, session.name, entry.name))).size;
			} catch {
				// Active logs have no closed marker and are intentionally excluded.
			}
		}
	}
	return bytes;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("JobManager shutdown and process boundaries", () => {
	it("removes a grace-expired job and detaches late output and settlement from the full job", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const execution = deferred<{ exitCode: number | null }>();
		const notifications = { enqueue: vi.fn(), suppress: vi.fn() };
		let lateOutput: ((data: Buffer) => void) | undefined;
		let createdLog: JobLog | undefined;
		let shutdownState: { status: string; terminalCause?: string } | undefined;
		let observedBeforeRemoval = false;
		let manager: JobManager;
		manager = new JobManager({
			logsDirectory: directory,
			createLog: (path) => {
				createdLog = new JobLog({ path });
				return createdLog;
			},
			execute: ({ onData }) => {
				lateOutput = onData;
				return execution.promise;
			},
			notifications: notifications as any,
			onStateChange: (job) => {
				if (job.status !== "shutdown") return;
				shutdownState = { status: job.status, terminalCause: job.terminalCause };
				observedBeforeRemoval = manager.get(job.id)?.status === "shutdown";
			},
		});
		const started = await manager.start({ command: "late", timeoutSeconds: 0, context: context(directory) });
		if (!started.ok) throw new Error("job not accepted");
		await manager.abortAndSettleAll({ graceMs: 1 });
		expect(shutdownState).toEqual({ status: "shutdown", terminalCause: "shutdown" });
		expect(observedBeforeRemoval).toBe(true);
		expect(manager.get(started.details.jobId)).toBeUndefined();
		expect(createdLog?.summary().closed).toBe(true);
		lateOutput?.(Buffer.from("must be ignored"));
		execution.resolve({ exitCode: 0 });
		await Promise.resolve();
		expect(createdLog?.summary().bytes).toBe(0);
		expect(notifications.enqueue).not.toHaveBeenCalled();
	});

	it("kills the ordinary process group but documents escaping descendants as unsupported", async () => {
		const directory = await mkdtemp(join(tmpdir(), "bash-async-manager-"));
		tempDirectories.push(directory);
		const escapedPidFile = join(directory, "escaped.pid");
		const manager = new JobManager({ logsDirectory: directory });
		const command = `PID_FILE=${JSON.stringify(escapedPidFile)} python3 -c "import os,subprocess,time; p=subprocess.Popen(['sleep','30'], start_new_session=True); open(os.environ['PID_FILE'],'w').write(str(p.pid)); time.sleep(30)"`;
		const started = await manager.start({ command, timeoutSeconds: 0, context: context(directory) });
		if (!started.ok) throw new Error("job not accepted");
		await vi.waitFor(async () => expect(Number(await readFile(escapedPidFile, "utf8"))).toBeGreaterThan(0));
		const escapedPid = Number(await readFile(escapedPidFile, "utf8"));
		try {
			expect((await manager.kill(started.details.jobId))?.status).toBe("killed");
			expect(isProcessAlive(escapedPid)).toBe(true);
		} finally {
			if (isProcessAlive(escapedPid)) process.kill(escapedPid, "SIGKILL");
			await vi.waitFor(() => expect(isProcessAlive(escapedPid)).toBe(false));
		}
	});
});
