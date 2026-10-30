/** biome-ignore-all lint/suspicious/noExplicitAny: tool results are read through lightweight fixtures. */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareBashArguments } from "./bash-tool.ts";
import { type AdoptRequest, type ForegroundRequest, MAX_TIMER_SECONDS, runForeground } from "./foreground.ts";
import enhancedBash from "./index.ts";

function makeBashTool(): ToolDefinition {
	let tool: ToolDefinition | undefined;
	const host = {
		on() {},
		events: { on() {}, emit() {} },
		registerTool(definition: ToolDefinition) {
			if (definition.name === "bash") tool = definition;
		},
	};
	enhancedBash(host as unknown as ExtensionAPI);
	if (!tool?.renderCall) throw new Error("bash tool was not registered");
	return tool;
}

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

function renderCommand(command: string, cwd: string, expanded: boolean): string {
	const tool = makeBashTool();
	const renderCall = tool.renderCall as unknown as (
		args: unknown,
		theme: unknown,
		context: unknown,
	) => { render(width: number): string[] };
	return renderCall({ command, title: "상태 확인" }, theme, { cwd, expanded }).render(160).join("\n");
}

describe("bash tool command preview", () => {
	it("abbreviates a leading cd to the session cwd in collapsed mode", () => {
		const cwd = "/Users/example/.worktrees/project/temp-20260812-061136";
		const rendered = renderCommand(`cd ${cwd} && git status --short`, cwd, false);

		expect(rendered).toContain("$ cd <cwd> && git status --short");
		expect(rendered).not.toContain(cwd);
	});

	it("keeps the full cwd in expanded mode", () => {
		const cwd = "/Users/example/project";
		const rendered = renderCommand(`cd ${cwd} && git status --short`, cwd, true);

		expect(rendered).toContain(`$ cd ${cwd} && git status --short`);
	});

	it("does not abbreviate a cd to a different directory", () => {
		const rendered = renderCommand("cd /Users/example/other && git status --short", "/Users/example/project", false);

		expect(rendered).toContain("$ cd /Users/example/other && git status --short");
	});

	it("abbreviates the cwd prefix of a subdirectory cd", () => {
		const cwd = "/Users/example/project";
		const rendered = renderCommand(`cd ${cwd}/packages/api && pnpm test`, cwd, false);

		expect(rendered).toContain("$ cd <cwd>/packages/api && pnpm test");
		expect(rendered).not.toContain(cwd);
	});

	it("abbreviates a quoted subdirectory cd", () => {
		const cwd = "/Users/example/project";
		const rendered = renderCommand(`cd '${cwd}/packages/api' && pnpm test`, cwd, false);

		expect(rendered).toContain("$ cd <cwd>/packages/api && pnpm test");
	});

	it("abbreviates a cd terminated by a shell separator", () => {
		const cwd = "/Users/example/project";

		expect(renderCommand(`cd ${cwd}; ls`, cwd, false)).toContain("$ cd <cwd>; ls");
		expect(renderCommand(`cd ${cwd}/packages; ls`, cwd, false)).toContain("$ cd <cwd>/packages; ls");
	});

	it("does not abbreviate a sibling directory sharing the cwd prefix", () => {
		const cwd = "/Users/example/project";
		const rendered = renderCommand(`cd ${cwd}extra && ls`, cwd, false);

		expect(rendered).toContain(`$ cd ${cwd}extra && ls`);
	});
});

describe("foreground bash", () => {
	const directories: string[] = [];

	afterEach(async () => {
		vi.unstubAllEnvs();
		await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	async function setup() {
		vi.stubEnv("PI_ENHANCED_BASH_SYNC_WINDOW_MS", "0");
		const cwd = await mkdtemp(join(tmpdir(), "enhanced-bash-foreground-"));
		directories.push(cwd);
		const tools: Record<string, ToolDefinition> = {};
		const handlers = new Map<string, () => unknown>();
		const sendMessage = vi.fn();
		const host = {
			on: (event: string, handler: () => unknown) => handlers.set(event, handler),
			sendMessage,
			registerTool(definition: ToolDefinition) {
				tools[definition.name] = definition;
			},
		};
		enhancedBash(host as unknown as ExtensionAPI);
		const context = {
			cwd,
			mode: "print",
			hasUI: false,
			model: undefined,
			sessionManager: { getSessionId: () => "foreground-test", getSessionFile: () => undefined },
		} as unknown as ExtensionContext;
		type Run = (params: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
		const call =
			(name: string): Run =>
			(params, signal) =>
				(tools[name]?.execute as any)("call", params, signal, undefined, context);
		return {
			bash: call("bash"),
			stop: call("bash_stop"),
			sendMessage,
			shutdown: () => handlers.get("session_shutdown")?.(),
		};
	}

	it("returns the built-in result for a command that finishes in time and never reports it again", async () => {
		const { bash, sendMessage, shutdown } = await setup();
		try {
			const done = await bash({ command: "printf 'one\\ntwo'", title: "print" });
			expect(done.content[0].text).toBe("one\ntwo");
			expect(done.details?.jobId).toBeUndefined();
			const failed = await bash({ command: "printf oops; exit 3", title: "fail" });
			expect(failed.isError).toBe(true);
			expect(failed.content[0].text).toContain("Command exited with code 3");
			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			await shutdown();
		}
	});

	it.runIf(process.platform === "darwin")("adds a macOS hint to a command that fails on a GNU-only flag", async () => {
		const { bash, shutdown } = await setup();
		try {
			const failed = await bash({ command: "seq 3 | head -n -1", title: "gnu head" });
			expect(failed.isError).toBe(true);
			expect(failed.content[0].text).toContain("[macOS hint]");
			expect(failed.content[0].text).toContain("sed '$d'");
		} finally {
			await shutdown();
		}
	});

	it.runIf(process.platform === "darwin" && existsSync("/opt/homebrew/bin/bash"))(
		"runs bash 4+ builtins on macOS through Homebrew bash",
		async () => {
			const { bash, shutdown } = await setup();
			try {
				const done = await bash({
					// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a bash array length, not a JS template.
					command: "mapfile -t lines < <(printf 'a\\nb\\n'); echo ${#lines[@]}",
					title: "mapfile",
				});
				expect(done.content[0].text.trim()).toBe("2");
			} finally {
				await shutdown();
			}
		},
	);

	it("moves a command that outlives its timeout to the background and reports output from before and after the move", async () => {
		const { bash, sendMessage, shutdown } = await setup();
		try {
			const moved = await bash({ command: "printf before; sleep 1; printf after", title: "slow", timeout: 0.3 });
			expect(moved.content[0].text).toContain(`moved to background job ${moved.details.jobId}`);
			expect(moved.content[0].text).toContain("before");
			await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { timeout: 4_000 });
			const [message, options] = sendMessage.mock.calls[0] ?? [];
			expect(message.details.jobIds).toEqual([moved.details.jobId]);
			expect(message.content).toContain("succeeded");
			expect(message.content).toContain("beforeafter");
			expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		} finally {
			await shutdown();
		}
	}, 10_000);

	it("stops a moved command with bash_stop without reporting it", async () => {
		const { bash, stop, sendMessage, shutdown } = await setup();
		try {
			const moved = await bash({ command: "sleep 30", title: "long", timeout: 0.2 });
			const stopped = await stop({ jobId: moved.details.jobId });
			expect(stopped.details).toMatchObject({ jobId: moved.details.jobId, status: "killed" });
			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			await shutdown();
		}
	});

	it("kills the command when the call is interrupted before its timeout", async () => {
		const { bash, sendMessage, shutdown } = await setup();
		try {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 200);
			const begun = Date.now();
			await expect(bash({ command: "sleep 30", title: "abort" }, controller.signal)).rejects.toThrow("Command aborted");
			expect(Date.now() - begun).toBeLessThan(5_000);
			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(sendMessage).not.toHaveBeenCalled();
		} finally {
			await shutdown();
		}
	});
});

describe("foreground move boundary", () => {
	const context = {
		cwd: tmpdir(),
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "boundary-test", getSessionFile: () => undefined },
	} as unknown as ExtensionContext;

	/** A command that prints `output` and then ends only when aborted, `abortDelayMs` after the abort. */
	function hangingOperations(output: string, abortDelayMs = 0): BashOperations {
		return {
			exec: (_command, _cwd, { onData, signal }) =>
				new Promise((_resolve, reject) => {
					onData(Buffer.from(output));
					signal?.addEventListener("abort", () => setTimeout(() => reject(new Error("aborted")), abortDelayMs), {
						once: true,
					});
				}),
		};
	}

	function request(overrides: Partial<ForegroundRequest>): ForegroundRequest {
		return {
			toolCallId: "call",
			command: "irrelevant",
			title: "boundary",
			waitSeconds: 0.1,
			backgroundTimeoutSeconds: 60,
			context: context as ForegroundRequest["context"],
			adopt: async () => ({ content: [{ type: "text", text: "moved" }], details: {} }),
			...overrides,
		};
	}

	it("lets an interrupt that lands at the timeout boundary cancel the command instead of moving it", async () => {
		const adopt = vi.fn(async (_moved: AdoptRequest) => ({ content: [], details: {} }));
		const controller = new AbortController();
		// The abort arrives just before the wait ends, and the process takes longer than that to exit.
		setTimeout(() => controller.abort(), 60);
		await expect(
			runForeground(request({ operations: hangingOperations("partial", 120), signal: controller.signal, adopt })),
		).rejects.toThrow("aborted");
		expect(adopt).not.toHaveBeenCalled();
	});

	it("puts the output printed before the move into the error when the background cannot take the command", async () => {
		const adopt = async () => {
			throw new Error("background bash is shutting down");
		};
		await expect(
			runForeground(request({ operations: hangingOperations("line one\nline two"), adopt })),
		).rejects.toThrow(/line one\nline two\n\nbackground bash is shutting down/);
	});

	it("reports an interrupt during adoption as an aborted command with the earlier output", async () => {
		const controller = new AbortController();
		const adopt = async () => {
			controller.abort();
			throw new Error("background bash start was cancelled before job acceptance.");
		};
		await expect(
			runForeground(request({ operations: hangingOperations("before"), signal: controller.signal, adopt })),
		).rejects.toThrow("before\n\nCommand aborted");
	});

	it("keeps waiting for a timeout too large for a timer instead of moving the command at once", async () => {
		const adopt = vi.fn(async (_moved: AdoptRequest) => ({ content: [], details: {} }));
		const operations: BashOperations = {
			exec: (_command, _cwd, { onData }) =>
				new Promise((resolve) =>
					setTimeout(() => {
						onData(Buffer.from("done"));
						resolve({ exitCode: 0 });
					}, 80),
				),
		};
		const result = await runForeground(request({ operations, waitSeconds: 1e12, adopt }));
		expect(result.content[0]).toMatchObject({ text: "done" });
		expect(adopt).not.toHaveBeenCalled();
		expect(MAX_TIMER_SECONDS * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
	});

	it("ignores a non-finite timeout", () => {
		expect(
			prepareBashArguments({ command: "x", title: "t", timeout: Number.POSITIVE_INFINITY }).timeout,
		).toBeUndefined();
		expect(prepareBashArguments({ command: "x", title: "t", timeout: 5 }).timeout).toBe(5);
	});
});
