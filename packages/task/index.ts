import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildContextSnapshot } from "./context/context.js";
import { TaskManager } from "./manager.js";
import { loadTaskConfig } from "./routing/config.js";
import { evaluateTask } from "./routing/evaluate.js";
import { createRpcWorker } from "./runtime/rpc-worker.js";
import { isActive, TaskStore } from "./store.js";
import type { TaskRecord } from "./types.js";

const result = (text: string, details: unknown = {}, isError = false) => ({
	content: [{ type: "text" as const, text }],
	details,
	...(isError ? { isError: true } : {}),
});
const summary = (record: TaskRecord): string =>
	`${record.id} r${record.revision}: ${record.status}${record.tier ? ` (${record.tier})` : ""}\n${record.instructions.at(-1) ?? ""}`;
const noticeKey = (id: string, revision: number) => `${id}:${revision}`;
function completionIdentity(value: unknown): { taskId: string; revision: number } | undefined {
	if (!value || typeof value !== "object" || !("taskId" in value) || !("revision" in value)) return;
	if (typeof value.taskId !== "string" || typeof value.revision !== "number") return;
	return { taskId: value.taskId, revision: value.revision };
}

export default function taskExtension(pi: ExtensionAPI): void {
	// The child-only bridge is loaded explicitly by the RPC runner.
	if (process.env.PI_TASK_WORKER === "1") return;
	let manager: TaskManager | undefined;
	let sessionId: string | undefined;
	let currentContext: ExtensionContext | undefined;
	let generation = 0;
	let initializing: Promise<TaskManager> | undefined;
	const pendingNotices = new Set<string>();

	const sendReport = (record: TaskRecord, triggerTurn = true) => {
		if (!record.report || record.completionDelivered || record.parentSessionId !== sessionId) return;
		const key = noticeKey(record.id, record.revision);
		if (pendingNotices.has(key)) return;
		pendingNotices.add(key);
		const report = record.report;
		const text = [
			`[Task ${record.id} revision ${record.revision}] ${report.status}`,
			report.summary,
			...(report.artifacts.length ? ["Artifacts:", ...report.artifacts] : []),
			...(report.verification.length ? ["Verification:", ...report.verification] : []),
			...(report.blockers.length ? ["Blockers:", ...report.blockers] : []),
		].join("\n");
		try {
			pi.sendMessage(
				{ customType: "task-completion", content: text, display: true, details: report },
				{ deliverAs: "steer", triggerTurn },
			);
		} catch (error) {
			pendingNotices.delete(key);
			throw error;
		}
	};

	const ensure = async (ctx: ExtensionContext): Promise<TaskManager> => {
		const id = ctx.sessionManager.getSessionId();
		currentContext = ctx;
		if (manager && sessionId === id) return manager;
		if (initializing && sessionId === id) return initializing;
		const token = ++generation;
		const previous = manager;
		manager = undefined;
		sessionId = id;
		pendingNotices.clear();
		initializing = (async () => {
			await previous?.close();
			if (token !== generation) throw new Error("Parent session changed during Task initialization");
			const config = loadTaskConfig(ctx.cwd, ctx.model);
			const created = new TaskManager({
				store: new TaskStore(path.join(getAgentDir(), "tasks"), id),
				cwd: ctx.cwd,
				maxConcurrency: config.maxConcurrency,
				evaluate: (instructions, snapshot, signal) => {
					const activeContext = currentContext ?? ctx;
					const routing = loadTaskConfig(activeContext.cwd, activeContext.model);
					return evaluateTask(instructions, snapshot, routing, activeContext, signal);
				},
				createWorker: createRpcWorker,
				onTerminal: (record) => {
					if (token === generation) sendReport(record);
				},
				onLongRunning: (record, elapsedMs) => {
					if (token !== generation || record.parentSessionId !== sessionId) return;
					pi.sendMessage(
						{
							customType: "task-long-running",
							display: true,
							details: { taskId: record.id, revision: record.revision, elapsedMs },
							content: [
								`[Task ${record.id} revision ${record.revision}] Still active after ${Math.floor(elapsedMs / 60_000)} minutes.`,
								"This is a one-time progress notice, not a final report. The worker and its background jobs have not been interrupted.",
								"Review the Task or send revised instructions if intervention is needed. Otherwise await task_report without polling.",
							].join("\n"),
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
				},
			});
			manager = created;
			return created;
		})();
		try {
			return await initializing;
		} finally {
			if (token === generation) initializing = undefined;
		}
	};

	pi.registerTool({
		name: "Task",
		label: "Task",
		description:
			"Delegate a task asynchronously. The extension evaluates fast/balanced/powerful and runs a persistent Pi worker. Create returns a Task ID immediately; wait for the automatic final task_report, not status polling. Edit aborts the current model turn, adds instructions, reevaluates and resumes the same worker. Detached bash_async jobs remain owned by that worker. readonly is guidance, not a sandbox.",
		promptGuidelines: [
			"Use Task for independent delegation. Partition write scopes because workers share the working directory.",
			"Task({task: '...'}), Task({action: 'edit', taskId: '...', task: '...'}). Do not poll to wait; final reports arrive automatically.",
			"abort interrupts only the current model operation. Background completion can wake the same worker again. Parent shutdown stops its workers.",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([
					Type.Literal("create"),
					Type.Literal("edit"),
					Type.Literal("resume"),
					Type.Literal("abort"),
					Type.Literal("list"),
					Type.Literal("detail"),
				]),
			),
			task: Type.Optional(Type.String({ description: "Task instruction or additive edit." })),
			taskId: Type.Optional(Type.String()),
			readonly: Type.Optional(Type.Boolean({ description: "Instruction-based read-only mode for a new Task." })),
		}),
		executionMode: "parallel",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				const active = await ensure(ctx);
				const action = params.action ?? "create";
				if (action === "list") {
					const records = active.list();
					return result(records.map(summary).join("\n\n") || "No Tasks.", { tasks: records });
				}
				if (action === "create") {
					if (!params.task) throw new Error("task is required");
					const record = active.create(
						params.task,
						buildContextSnapshot(ctx.sessionManager.getBranch()),
						params.readonly,
					);
					return result(`${summary(record)}\nAccepted asynchronously. A final report will arrive automatically.`, {
						task: record,
					});
				}
				if (!params.taskId) throw new Error("taskId is required");
				if (action === "detail") {
					const record = active.get(params.taskId);
					return result(JSON.stringify(record, null, 2), { task: record });
				}
				if (action === "abort") {
					const record = await active.abort(params.taskId);
					return result(
						`${summary(record)}\nOnly the model operation was interrupted; worker-owned background jobs may continue.`,
						{ task: record },
					);
				}
				const instruction =
					params.task ??
					(action === "resume" ? "Resume the task from the preserved context and report the final outcome." : "");
				const record = await active.edit(
					params.taskId,
					instruction,
					buildContextSnapshot(ctx.sessionManager.getBranch()),
				);
				return result(`${summary(record)}\nEdit accepted. Await the automatic final report.`, { task: record });
			} catch (error) {
				return result(error instanceof Error ? error.message : String(error), {}, true);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const active = await ensure(ctx);
			const interrupted = active.takeInterruptions();
			if (interrupted.length) {
				const message = `Interrupted Tasks (not automatically restarted):\n${interrupted.map(summary).join("\n")}`;
				ctx.ui.notify(message, "warning");
				pi.sendMessage({ customType: "task-recovery", content: message, display: true }, { triggerTurn: false });
			}
			for (const record of active.list()) sendReport(record, false);
		} catch (error) {
			ctx.ui.notify(`Task setup: ${String(error)}`, "error");
		}
	});

	pi.on("context", (event) => {
		if (!manager) return;
		const active = manager;
		const messages = event.messages.filter((message) => {
			if (
				message.role !== "custom" ||
				(message.customType !== "task-completion" && message.customType !== "task-long-running")
			)
				return true;
			const identity = completionIdentity(message.details);
			if (!identity) return false;
			let record: TaskRecord;
			try {
				record = active.get(identity.taskId);
			} catch {
				return false;
			}
			if (record.revision !== identity.revision) return false;
			if (message.customType === "task-long-running") return isActive(record.status);
			active.markDelivered(identity.taskId, identity.revision);
			pendingNotices.delete(noticeKey(identity.taskId, identity.revision));
			return true;
		});
		return { messages };
	});

	pi.on("session_shutdown", async () => {
		++generation;
		const active = manager;
		manager = undefined;
		sessionId = undefined;
		currentContext = undefined;
		pendingNotices.clear();
		await active?.close();
	});
}
