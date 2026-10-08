import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type TaskTier = "fast" | "balanced" | "powerful";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelSelection {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
}
export interface TaskConfig {
	maxConcurrency: number;
	preferClassifier: boolean;
	classifier?: { provider: string; model: string };
	evaluator?: ModelSelection;
	evaluatorFallbacks: Record<string, ModelSelection>;
	presets: Record<TaskTier, ModelSelection>;
}
export interface ContextEntry {
	ref: string;
	role: string;
	text: string;
}
export interface TaskContextSnapshot {
	brief: string;
	entries: ContextEntry[];
}
export interface TaskReport {
	taskId: string;
	revision: number;
	status: "success" | "failed" | "blocked";
	summary: string;
	artifacts: string[];
	verification: string[];
	blockers: string[];
}
export type TaskStatus =
	| "queued"
	| "evaluating"
	| "running"
	| "waiting"
	| "completed"
	| "failed"
	| "blocked"
	| "interrupted";
export interface TaskRecord {
	id: string;
	revision: number;
	parentSessionId: string;
	cwd: string;
	instructions: string[];
	readonly: boolean;
	status: TaskStatus;
	createdAt: string;
	updatedAt: string;
	sessionFile: string;
	contextFile: string;
	tier?: TaskTier;
	selection?: ModelSelection;
	report?: TaskReport;
	error?: string;
	interruptionNotified?: boolean;
	completionDelivered?: boolean;
}
export interface EvaluationResult {
	tier: TaskTier;
	selection: ModelSelection;
	evaluator: string;
}
export type EvaluateTask = (
	instructions: readonly string[],
	context: TaskContextSnapshot,
	config: TaskConfig,
	ctx: Pick<ExtensionContext, "modelRegistry" | "model">,
	signal?: AbortSignal,
) => Promise<EvaluationResult>;
export interface WorkerInput {
	revision: number;
	prompt: string;
	selection: ModelSelection;
}
export interface WorkerOptions {
	taskId: string;
	cwd: string;
	sessionFile: string;
	contextFile: string;
	readonly: boolean;
	cliPath?: string;
	nodePath?: string;
	extraArgs?: string[];
	env?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
}
export interface WorkerEvents {
	onReport(report: TaskReport): void;
	onActivity(state: "running" | "waiting"): void;
	onExit(error?: string): void;
	onError(error: string): void;
}
export interface TaskWorker {
	start(input: WorkerInput): Promise<void>;
	update(input: WorkerInput): Promise<void>;
	abort(): Promise<void>;
	stop(): Promise<void>;
}
export type WorkerFactory = (options: WorkerOptions, events: WorkerEvents) => TaskWorker;
