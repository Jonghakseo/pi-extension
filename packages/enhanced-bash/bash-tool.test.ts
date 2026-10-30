/** biome-ignore-all lint/suspicious/noExplicitAny: tool results are read through lightweight fixtures. */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
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
