import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { BASH_ASYNC_ACTIONS, type BashAsyncAction, type NormalizedBashAsyncParams } from "./types.js";

export const TOOL_NAME = "bash_async";
export const TOOL_LABEL = "Bash Async";
export const DEFAULT_TIMEOUT_SECONDS = 1_800;
export const DEFAULT_OUTPUT_LINES = 50;
export const MAX_OUTPUT_LINES = 200;

export const TOOL_DESCRIPTION = `Run a finite, non-interactive shell command in the background. Use bash_async start for commands expected to take more than 30 seconds when the next action does not need their result immediately. Do not call sleep or poll status, output, or list to wait. Continue only with work that does not depend on the job; otherwise end the turn. Success, failure, timeout, and kill results arrive automatically as a follow-up. Query output only when early output is needed or the user asks; repeated queries that return no new information are rate limited and fail. TUI, REPL, and commands requiring stdin are unsupported.`;

export const toolParameters = Type.Object({
	action: StringEnum(BASH_ASYNC_ACTIONS, {
		description: "Operation to perform: start, status, output, kill, or list.",
	}),
	command: Type.Optional(Type.String({ description: "Command for start." })),
	title: Type.Optional(Type.String({ description: "Optional short job title for start." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for start." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds. Defaults to 1800; 0 disables it." })),
	jobId: Type.Optional(Type.String({ description: "Job ID for status, output, or kill." })),
	lines: Type.Optional(Type.Number({ description: "Output line limit, default 50 and maximum 200." })),
	outputOffset: Type.Optional(Type.Number({ description: "Absolute retained-line offset for output." })),
	incremental: Type.Optional(Type.Boolean({ description: "Return output not returned by a prior incremental query." })),
});

export interface BashAsyncParams {
	action?: unknown;
	command?: unknown;
	title?: unknown;
	cwd?: unknown;
	timeout?: unknown;
	jobId?: unknown;
	lines?: unknown;
	outputOffset?: unknown;
	incremental?: unknown;
}

export type ParamsValidationResult = { ok: true; value: NormalizedBashAsyncParams } | { ok: false; error: string };

export type CwdValidationResult = { ok: true; cwd: string } | { ok: false; error: string };

export function clampOutputLines(lines: unknown): number {
	if (typeof lines !== "number" || !Number.isFinite(lines)) return DEFAULT_OUTPUT_LINES;
	return Math.min(MAX_OUTPUT_LINES, Math.max(1, Math.floor(lines)));
}

function isAction(value: unknown): value is BashAsyncAction {
	return typeof value === "string" && (BASH_ASYNC_ACTIONS as readonly string[]).includes(value);
}

function hasValue(params: BashAsyncParams, key: "command" | "jobId"): boolean {
	return params[key] !== undefined;
}

function validateOptionalStartFields(params: BashAsyncParams): string | undefined {
	if (params.title !== undefined && typeof params.title !== "string") return "title must be a string.";
	if (params.cwd !== undefined && typeof params.cwd !== "string") return "cwd must be a string.";
	if (
		params.timeout !== undefined &&
		(typeof params.timeout !== "number" || !Number.isFinite(params.timeout) || params.timeout < 0)
	) {
		return "timeout must be a finite number greater than or equal to 0.";
	}
	return undefined;
}

function validateOutputFields(params: BashAsyncParams): string | undefined {
	if (params.lines !== undefined && (typeof params.lines !== "number" || !Number.isFinite(params.lines))) {
		return "lines must be a finite number.";
	}
	if (
		params.outputOffset !== undefined &&
		(typeof params.outputOffset !== "number" || !Number.isFinite(params.outputOffset) || params.outputOffset < 0)
	) {
		return "outputOffset must be a finite number greater than or equal to 0.";
	}
	if (params.incremental !== undefined && typeof params.incremental !== "boolean")
		return "incremental must be a boolean.";
	return undefined;
}

function validateStartParams(params: BashAsyncParams): ParamsValidationResult {
	if (typeof params.command !== "string" || params.command.trim() === "") {
		return { ok: false, error: "start requires a non-empty command." };
	}
	if (hasValue(params, "jobId")) return { ok: false, error: "start does not accept jobId." };
	const startError = validateOptionalStartFields(params);
	if (startError) return { ok: false, error: startError };
	return {
		ok: true,
		value: {
			action: "start",
			command: params.command,
			title: typeof params.title === "string" ? params.title : undefined,
			cwd: typeof params.cwd === "string" ? params.cwd : undefined,
			timeoutSeconds: typeof params.timeout === "number" ? params.timeout : DEFAULT_TIMEOUT_SECONDS,
		},
	};
}

export function validateBashAsyncParams(params: BashAsyncParams): ParamsValidationResult {
	if (!isAction(params.action)) return { ok: false, error: "action must be start, status, output, kill, or list." };

	if (params.action === "start") return validateStartParams(params);

	if (params.action === "list") {
		if (hasValue(params, "command") || hasValue(params, "jobId")) {
			return { ok: false, error: "list does not accept command or jobId." };
		}
		return { ok: true, value: { action: "list" } };
	}

	if (hasValue(params, "command")) return { ok: false, error: `${params.action} does not accept command.` };
	const jobId = params.jobId;
	if (typeof jobId !== "string" || jobId.trim() === "") {
		return { ok: false, error: `${params.action} requires a non-empty jobId.` };
	}
	const outputError = validateOutputFields(params);
	if (outputError) return { ok: false, error: outputError };
	const lines = typeof params.lines === "number" ? clampOutputLines(params.lines) : undefined;
	const outputOffset = typeof params.outputOffset === "number" ? Math.floor(params.outputOffset) : undefined;
	const incremental = typeof params.incremental === "boolean" ? params.incremental : undefined;
	return {
		ok: true,
		value: {
			action: params.action,
			jobId,
			lines,
			outputOffset,
			incremental,
		},
	};
}

/** Resolves against the current tool cwd and follows symlinks before accepting a job. */
export async function validateCwd(cwd: string | undefined, contextCwd: string): Promise<CwdValidationResult> {
	const resolvedCwd = resolve(contextCwd, cwd ?? ".");
	try {
		const stats = await stat(resolvedCwd);
		if (!stats.isDirectory()) return { ok: false, error: `cwd is not a directory: ${resolvedCwd}` };
		return { ok: true, cwd: resolvedCwd };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `cwd does not exist or cannot be accessed: ${resolvedCwd} (${reason})` };
	}
}
