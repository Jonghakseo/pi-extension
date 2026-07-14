import * as childProcess from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentRuntime } from "./agents.js";
import type { CommandRunState } from "./types.js";

export const RUNNER_DIAGNOSTIC_CUSTOM_TYPE = "subagent-runner-diagnostic";
export const RUNNER_DIAGNOSTIC_SCHEMA_VERSION = 1;

export type RunnerDiagnosticEventName =
	| "spawn"
	| "abort_received"
	| "kill_intent"
	| "kill_result"
	| "process_error"
	| "exit"
	| "close"
	| "settled"
	| "session_shutdown";

export interface RunnerDiagnosticEvent {
	event: RunnerDiagnosticEventName;
	runtime?: AgentRuntime;
	parentPid?: number;
	parentProcessGroupId?: number;
	childPid?: number;
	childParentPid?: number;
	childProcessGroupId?: number;
	processGroupMode?: "inherited";
	code?: number | null;
	signal?: NodeJS.Signals | null;
	cause?: string;
	abortReason?: unknown;
	killSent?: boolean;
	settleReason?: string;
	stopReason?: string;
	activeRunIds?: number[];
	sessionShutdownReason?: string;
	error?: DiagnosticError;
}

export type RunnerDiagnosticSink = (event: RunnerDiagnosticEvent) => void;

interface DiagnosticError {
	name?: string;
	message: string;
	stack?: string;
}

interface ProcessIdentity {
	pid: number;
	parentPid?: number;
	processGroupId?: number;
}

function asFiniteInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isInteger(parsed) ? parsed : undefined;
}

/** Best-effort POSIX process identity lookup. Diagnostics must never affect execution. */
export function readProcessIdentity(pid: number | undefined): ProcessIdentity | undefined {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "win32") return { pid };

	try {
		const result = childProcess.spawnSync("ps", ["-o", "pid=,ppid=,pgid=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const fields = result.stdout?.trim().split(/\s+/);
		if (!fields || fields.length < 3) return { pid };
		return {
			pid: asFiniteInteger(fields[0]) ?? pid,
			parentPid: asFiniteInteger(fields[1]),
			processGroupId: asFiniteInteger(fields[2]),
		};
	} catch {
		return { pid };
	}
}

export function serializeDiagnosticValue(value: unknown): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	if (value === undefined || value === null) return value;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;

	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return String(value);
	}
}

export function toDiagnosticError(error: unknown): DiagnosticError {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack };
	}
	return { message: String(error) };
}

/** Emit best-effort diagnostics without allowing logging failures to affect a run. */
export function emitRunnerDiagnostic(sink: RunnerDiagnosticSink | undefined, event: RunnerDiagnosticEvent): void {
	if (!sink) return;
	try {
		sink(event);
	} catch {
		// Diagnostics must never alter subagent execution or completion delivery.
	}
}

export function appendRunnerDiagnostic(pi: Pick<ExtensionAPI, "appendEntry">, data: Record<string, unknown>): void {
	try {
		pi.appendEntry(RUNNER_DIAGNOSTIC_CUSTOM_TYPE, {
			schemaVersion: RUNNER_DIAGNOSTIC_SCHEMA_VERSION,
			recordedAt: new Date().toISOString(),
			...data,
		});
	} catch {
		// Session teardown may invalidate the old extension runtime.
	}
}

export function createRunDiagnosticSink(
	pi: Pick<ExtensionAPI, "appendEntry">,
	runState: CommandRunState,
): RunnerDiagnosticSink {
	return (event) => {
		appendRunnerDiagnostic(pi, {
			runId: runState.id,
			agent: runState.agent,
			batchId: runState.batchId,
			pipelineId: runState.pipelineId,
			pipelineStepIndex: runState.pipelineStepIndex,
			...event,
			abortReason: serializeDiagnosticValue(event.abortReason),
		});
	};
}
