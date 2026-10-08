/**
 * Contract shared by the parent-side RPC worker and the private bridge extension that runs inside
 * the child Pi process. Both sides are loaded from the same package directory, so these names are
 * the only coupling between them: tool names, the control channel, env keys, and report validation.
 */
import type { TaskReport } from "../types.js";

/** The only way a child can finish a Task revision. */
export const TASK_REPORT_TOOL = "task_report";
/** Read access to the parent conversation snapshot the manager wrote for this Task. */
export const TASK_CONTEXT_TOOL = "task_context";
/** Private slash command the parent uses to move the child to a new revision. */
export const WORKER_CONTROL_COMMAND = "task-worker-control";
/** System prompt section the bridge owns. */
export const WORKER_PROMPT_SECTION = "task_worker";

/** Set in every child process so the root Task extension skips registration there. */
export const ENV_WORKER_MARKER = "PI_TASK_WORKER";
export const ENV_TASK_ID = "PI_TASK_ID";
/** Only the starting revision. The live value moves through the control command. */
export const ENV_TASK_REVISION = "PI_TASK_REVISION";
export const ENV_TASK_CONTEXT_FILE = "PI_TASK_CONTEXT_FILE";
export const ENV_TASK_READONLY = "PI_TASK_READONLY";

/**
 * Delegation tools that would spawn another agent layer from inside a Task. Matched case
 * insensitively, blocked by the bridge, and additionally dropped by `--exclude-tools` at spawn.
 * Unknown delegation tools are only covered by the worker instructions.
 */
export const RECURSIVE_TOOL_NAMES = ["task", "subagent"] as const;

/** `tool_execution_end.result.details` of a successful `task_report` call. */
export interface TaskReportDetails {
	taskReport: TaskReport;
}

/** Control message the parent sends over the private slash command. */
export interface WorkerControlMessage {
	op: "activate";
	revision: number;
}

const REPORT_STATUSES: ReadonlySet<string> = new Set(["success", "failed", "blocked"]);

export function isRecursiveToolName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	return RECURSIVE_TOOL_NAMES.some((blocked) => blocked === normalized);
}

export function isRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function textList(value: unknown, field: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${field} must be an array of strings`);
	}
	return value.map((entry) => (entry as string).trim()).filter((entry) => entry.length > 0);
}

/** Builds the report a child hands back. Throws so the model sees a failed tool result. */
export function buildTaskReport(taskId: string, input: Record<string, unknown>): TaskReport {
	if (!isRevision(input.revision)) throw new Error("revision must be the active revision of this Task");
	if (typeof input.status !== "string" || !REPORT_STATUSES.has(input.status)) {
		throw new Error("status must be success, failed, or blocked");
	}
	const summary = typeof input.summary === "string" ? input.summary.trim() : "";
	if (!summary) throw new Error("summary must describe the outcome");
	return {
		taskId,
		revision: input.revision,
		status: input.status as TaskReport["status"],
		summary,
		artifacts: textList(input.artifacts, "artifacts"),
		verification: textList(input.verification, "verification"),
		blockers: textList(input.blockers, "blockers"),
	};
}

/**
 * Parent-side validation of a `task_report` tool result. Returns undefined for anything that is not
 * an exact report for this Task, so a text message or a hand-written details object cannot finish a
 * Task revision.
 */
export function parseTaskReportDetails(details: unknown, taskId: string): TaskReport | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { taskReport?: unknown }).taskReport;
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const report = candidate as Record<string, unknown>;
	if (report.taskId !== taskId) return undefined;
	try {
		const built = buildTaskReport(taskId, report);
		return built;
	} catch {
		return undefined;
	}
}

/** Parses the private control payload. The raw text never reaches the model. */
export function parseWorkerControl(raw: string): WorkerControlMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.trim());
	} catch {
		throw new Error("control payload is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("control payload must be an object");
	const message = parsed as Record<string, unknown>;
	if (message.op !== "activate") throw new Error("unsupported control op");
	if (!isRevision(message.revision)) throw new Error("control revision must be a positive integer");
	return { op: "activate", revision: message.revision };
}

/**
 * Standing rules for the child. The per-revision instructions arrive in the prompt; this section
 * carries the parts that must survive every turn, including turns woken by a background job.
 */
export function buildWorkerInstructions(input: { taskId: string; revision: number; readonly: boolean }): string {
	const lines = [
		`You are the worker for Task ${input.taskId}. The active revision is ${input.revision}.`,
		"Your conversation is isolated: the parent agent sees nothing except the report you file.",
		`Finish by calling ${TASK_REPORT_TOOL} with revision ${input.revision}. A normal assistant message, however complete it reads, does not finish the Task.`,
		`Report an honest status: success only when the work is verified, otherwise failed or blocked. Never claim a verification you did not run.`,
		`Call ${TASK_CONTEXT_TOOL} when you need the parent conversation beyond the brief in the prompt.`,
		"Background jobs you start keep running while your turn ends. Ending a turn is not finishing the Task: wait for the results, inspect them, and only then report.",
		`The worker process shuts down right after ${TASK_REPORT_TOOL} succeeds, so finish or deliberately abandon your background jobs before you report.`,
		"Do not delegate to another agent. Task, subagent, and similar delegation tools are blocked here; do the work yourself.",
		"The parent can replace your instructions mid-flight. When a new revision arrives, follow the newest instruction and report with the revision it names.",
	];
	if (input.readonly) {
		lines.push(
			"This Task is readonly: investigate and report, and do not change files, run mutating commands, or touch remote state. This is an instruction, not a sandbox, so it is on you to respect it.",
		);
	}
	return lines.join("\n");
}
