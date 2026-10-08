/**
 * Private extension loaded into every Task worker process. It gives the child exactly three things
 * the parent needs: a report channel, read access to the parent conversation snapshot, and a
 * control command that moves the child to a new revision without restarting the process.
 *
 * It is never installed by a user. The parent passes it with `--extension`, and the identity of the
 * Task arrives through `PI_TASK_*` environment variables.
 */
import { readFile } from "node:fs/promises";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { queryContext } from "../context/context.js";
import type { TaskContextSnapshot } from "../types.js";
import {
	buildTaskReport,
	buildWorkerInstructions,
	ENV_TASK_CONTEXT_FILE,
	ENV_TASK_ID,
	ENV_TASK_READONLY,
	ENV_TASK_REVISION,
	isRecursiveToolName,
	parseWorkerControl,
	TASK_CONTEXT_TOOL,
	TASK_REPORT_TOOL,
	type TaskReportDetails,
	WORKER_CONTROL_COMMAND,
	WORKER_PROMPT_SECTION,
} from "./protocol.js";

const ReportParams = Type.Object(
	{
		revision: Type.Integer({
			minimum: 1,
			description: "The active revision from your instructions. A stale revision is rejected.",
		}),
		status: Type.Union([Type.Literal("success"), Type.Literal("failed"), Type.Literal("blocked")], {
			description:
				"success only when the result is verified; failed when the work broke; blocked when you cannot continue.",
		}),
		summary: Type.String({ description: "What you did and what the parent now has, in a few sentences." }),
		artifacts: Type.Optional(
			Type.Array(Type.String(), { description: "Files, commands, or URLs the parent should look at." }),
		),
		verification: Type.Optional(
			Type.Array(Type.String(), {
				description: "Checks you actually ran, with their outcome. Leave empty when you ran none.",
			}),
		),
		blockers: Type.Optional(
			Type.Array(Type.String(), { description: "What stopped you, and what the parent must decide." }),
		),
	},
	{ additionalProperties: false },
);

const ContextParams = Type.Object(
	{
		query: Type.Optional(Type.String({ description: "Keywords to search the parent conversation snapshot for." })),
		refs: Type.Optional(
			Type.Array(Type.String(), { description: "Exact entry refs to expand, as returned by an earlier call." }),
		),
		offset: Type.Optional(
			Type.Integer({ minimum: 0, description: "Resume from this offset of a truncated earlier result." }),
		),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Characters per entry when expanding refs; otherwise the number of search or index results.",
			}),
		),
	},
	{ additionalProperties: false },
);

interface WorkerState {
	taskId: string;
	revision: number;
	readonly: boolean;
	contextFile: string;
}

function text(value: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text: value }], details: undefined };
}

async function readSnapshot(file: string): Promise<TaskContextSnapshot> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		throw new Error(
			`The parent conversation snapshot is unavailable (${file}). Continue from the instructions you have.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("The parent conversation snapshot is corrupt. Continue from the instructions you have.");
	}
	if (!parsed || typeof parsed !== "object") throw new Error("The parent conversation snapshot is corrupt.");
	const snapshot = parsed as Partial<TaskContextSnapshot>;
	return {
		brief: typeof snapshot.brief === "string" ? snapshot.brief : "",
		entries: Array.isArray(snapshot.entries) ? snapshot.entries : [],
	};
}

export default function taskWorkerBridge(pi: ExtensionAPI): void {
	const taskId = process.env[ENV_TASK_ID]?.trim();
	// Loaded outside a Task worker (a stray --extension, a user copy): register nothing.
	if (!taskId) return;
	const startingRevision = Number(process.env[ENV_TASK_REVISION]);
	const state: WorkerState = {
		taskId,
		revision: Number.isInteger(startingRevision) && startingRevision > 0 ? startingRevision : 1,
		readonly: process.env[ENV_TASK_READONLY] === "1",
		contextFile: process.env[ENV_TASK_CONTEXT_FILE] ?? "",
	};

	/** Delegation tools can register lazily, so the active set is filtered again every turn. */
	const dropRecursiveTools = (): void => {
		try {
			const active = pi.getActiveTools();
			const kept = active.filter((name) => !isRecursiveToolName(name));
			if (kept.length !== active.length) pi.setActiveTools(kept);
		} catch {
			// The tool registry is not ready yet; the tool_call block still covers this turn.
		}
	};

	pi.registerTool({
		name: TASK_REPORT_TOOL,
		label: "Task report",
		description:
			"File the final result of this Task revision with the parent agent. This is the only way to finish; a normal assistant message does not. The worker process shuts down after a successful report, so finish or abandon your background jobs first.",
		promptSnippet: "task_report: hand the final result of this Task back to the parent agent.",
		parameters: ReportParams,
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_toolCallId, params: Static<typeof ReportParams>): Promise<AgentToolResult<TaskReportDetails>> {
			if (params.revision !== state.revision) {
				throw new Error(
					`Revision ${params.revision} is not active. The active revision is ${state.revision}: re-read the newest instruction and report against it.`,
				);
			}
			const report = buildTaskReport(state.taskId, { ...params });
			return {
				content: [
					{
						type: "text",
						text: `Reported ${report.status} for revision ${report.revision}. The parent has the result and this worker is shutting down.`,
					},
				],
				details: { taskReport: report },
			};
		},
	});

	pi.registerTool({
		name: TASK_CONTEXT_TOOL,
		label: "Task context",
		description:
			"Read the parent conversation snapshot this Task was created from. Search it with a query, expand exact refs, and page through long entries with offset. The snapshot is frozen at the last instruction, so it never shows what the parent did afterwards.",
		promptSnippet: "task_context: read the parent conversation snapshot behind this Task.",
		parameters: ContextParams,
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_toolCallId, params: Static<typeof ContextParams>): Promise<AgentToolResult<undefined>> {
			if (!state.contextFile) throw new Error("This Task has no parent conversation snapshot.");
			const snapshot = await readSnapshot(state.contextFile);
			return text(queryContext(snapshot, params));
		},
	});

	pi.registerCommand(WORKER_CONTROL_COMMAND, {
		description: "Internal Task worker control channel.",
		handler: async (args) => {
			// Parent-only channel. Nothing from it is echoed back into the conversation.
			const message = parseWorkerControl(args);
			state.revision = message.revision;
		},
	});

	pi.on("tool_call", (event) => {
		if (!isRecursiveToolName(event.toolName)) return undefined;
		return {
			block: true,
			reason: `${event.toolName} is not available inside a Task. Do the work in this process and report it with ${TASK_REPORT_TOOL}.`,
		};
	});

	pi.on("session_start", () => {
		dropRecursiveTools();
	});

	pi.on("before_agent_start", (event) => {
		dropRecursiveTools();
		const options = event.systemPromptOptions;
		options.selectedTools = options.selectedTools.filter((name) => !isRecursiveToolName(name));
		options.sections[WORKER_PROMPT_SECTION] = buildWorkerInstructions(state);
		return undefined;
	});
}
