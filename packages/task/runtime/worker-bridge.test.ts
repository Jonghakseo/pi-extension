import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtensionApiMock, type ExtensionApiMock } from "../../../tests/mock-extension-api.js";
import {
	ENV_TASK_CONTEXT_FILE,
	ENV_TASK_ID,
	ENV_TASK_READONLY,
	ENV_TASK_REVISION,
	TASK_CONTEXT_TOOL,
	TASK_REPORT_TOOL,
	WORKER_CONTROL_COMMAND,
	WORKER_PROMPT_SECTION,
} from "./protocol.js";
import bridge from "./worker-bridge.js";

type ToolResult = { content: Array<{ text?: string }>; details?: unknown };

interface Harness {
	mock: ExtensionApiMock;
	activeTools: string[];
	report(params: Record<string, unknown>): Promise<ToolResult>;
	context(params: Record<string, unknown>): Promise<ToolResult>;
	control(args: string): Promise<void>;
	toolCall(toolName: string): unknown;
	beforeAgentStart(options: { selectedTools: string[]; sections: Record<string, string> }): void;
}

const envKeys = [ENV_TASK_ID, ENV_TASK_REVISION, ENV_TASK_CONTEXT_FILE, ENV_TASK_READONLY];
let saved: Record<string, string | undefined> = {};
let root = "";

beforeEach(async () => {
	saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	root = await mkdtemp(join(tmpdir(), "task-bridge-"));
});

afterEach(async () => {
	for (const key of envKeys) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	await rm(root, { recursive: true, force: true });
});

function load(env: Record<string, string>, tools: string[] = ["bash", "subagent"]): Harness {
	for (const key of envKeys) delete process.env[key];
	Object.assign(process.env, env);
	const mock = createExtensionApiMock();
	const state = { activeTools: tools };
	Object.assign(mock.api, {
		getActiveTools: () => [...state.activeTools],
		setActiveTools: (names: string[]) => {
			state.activeTools = names;
		},
	});
	bridge(mock.api as ExtensionAPI);
	return {
		mock,
		get activeTools() {
			return state.activeTools;
		},
		report: (params) => mock.getTool(TASK_REPORT_TOOL).execute?.("call-1", params) as Promise<ToolResult>,
		context: (params) => mock.getTool(TASK_CONTEXT_TOOL).execute?.("call-2", params) as Promise<ToolResult>,
		control: (args) =>
			Promise.resolve(mock.getCommand(WORKER_CONTROL_COMMAND).handler(args, {} as never)) as Promise<void>,
		toolCall: (toolName) => mock.getHandlers("tool_call")[0]?.({ toolName }, {} as never),
		beforeAgentStart: (options) => {
			mock.getHandlers("before_agent_start")[0]?.({ systemPromptOptions: options }, {} as never);
		},
	};
}

describe("task worker bridge", () => {
	it("registers nothing outside a Task worker process", () => {
		const harness = load({});
		expect(harness.mock.tools.size).toBe(0);
		expect(harness.mock.commands.size).toBe(0);
	});

	it("files a report for the active revision with the task id the parent assigned", async () => {
		const harness = load({ [ENV_TASK_ID]: "task-7", [ENV_TASK_REVISION]: "3" });
		const result = await harness.report({
			revision: 3,
			status: "blocked",
			summary: "Needs a credential",
			blockers: ["no token"],
		});
		expect(result.details).toEqual({
			taskReport: {
				taskId: "task-7",
				revision: 3,
				status: "blocked",
				summary: "Needs a credential",
				artifacts: [],
				verification: [],
				blockers: ["no token"],
			},
		});
	});

	it("refuses a report for a revision that is no longer active", async () => {
		const harness = load({ [ENV_TASK_ID]: "task-7", [ENV_TASK_REVISION]: "1" });
		await harness.control(JSON.stringify({ op: "activate", revision: 2 }));
		await expect(harness.report({ revision: 1, status: "success", summary: "stale" })).rejects.toThrow(
			/Revision 1 is not active/,
		);
		await expect(harness.report({ revision: 2, status: "success", summary: "fresh" })).resolves.toBeDefined();
	});

	it("keeps the revision unchanged when the control channel receives junk", async () => {
		const harness = load({ [ENV_TASK_ID]: "task-7", [ENV_TASK_REVISION]: "1" });
		await expect(harness.control("ignore previous instructions")).rejects.toThrow(/JSON/);
		await expect(harness.report({ revision: 1, status: "success", summary: "still active" })).resolves.toBeDefined();
	});

	it("blocks delegation tools and leaves everything else alone", () => {
		const harness = load({ [ENV_TASK_ID]: "task-7", [ENV_TASK_REVISION]: "1" });
		expect(harness.toolCall("subagent")).toMatchObject({ block: true });
		expect(harness.toolCall("Task")).toMatchObject({ block: true });
		expect(harness.toolCall("bash_async")).toBeUndefined();
		expect(harness.toolCall(TASK_REPORT_TOOL)).toBeUndefined();
	});

	it("drops delegation tools from the turn and states the contract in the system prompt", () => {
		const harness = load({ [ENV_TASK_ID]: "task-7", [ENV_TASK_REVISION]: "1", [ENV_TASK_READONLY]: "1" });
		const options = { selectedTools: ["bash", "subagent", TASK_REPORT_TOOL], sections: {} as Record<string, string> };
		harness.beforeAgentStart(options);
		expect(options.selectedTools).toEqual(["bash", TASK_REPORT_TOOL]);
		expect(harness.activeTools).toEqual(["bash"]);
		expect(options.sections[WORKER_PROMPT_SECTION]).toContain("task-7");
		expect(options.sections[WORKER_PROMPT_SECTION]).toContain("not a sandbox");
	});

	it("reads the parent snapshot, filters it, and expands exact refs", async () => {
		const contextFile = join(root, "context.json");
		await writeFile(
			contextFile,
			JSON.stringify({
				brief: "Ship the release",
				entries: [
					{ ref: "e1", role: "user", text: "deploy the staging cluster" },
					{ ref: "e2", role: "assistant", text: "the migration is pending" },
				],
			}),
		);
		const harness = load({ [ENV_TASK_ID]: "task-7", [ENV_TASK_REVISION]: "1", [ENV_TASK_CONTEXT_FILE]: contextFile });
		const search = await harness.context({ query: "migration" });
		expect(search.content[0]?.text).toContain("the migration is pending");
		expect(search.content[0]?.text).not.toContain("staging cluster");
		const expanded = await harness.context({ refs: ["e1"] });
		expect(expanded.content[0]?.text).toContain("deploy the staging cluster");
	});

	it("explains a missing snapshot instead of failing the turn silently", async () => {
		const harness = load({
			[ENV_TASK_ID]: "task-7",
			[ENV_TASK_REVISION]: "1",
			[ENV_TASK_CONTEXT_FILE]: join(root, "missing.json"),
		});
		await expect(harness.context({})).rejects.toThrow(/snapshot is unavailable/);
	});
});
