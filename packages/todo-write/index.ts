import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

type TodoTask = {
	id: string;
	content: string;
	status: TodoStatus;
	activeForm?: string;
	notes?: string;
};

type TodoState = {
	tasks: TodoTask[];
};

const StatusEnum = StringEnum(["pending", "in_progress", "completed"] as const, {
	description: "Task status",
});

const InputTask = Type.Object({
	content: Type.String({ description: "Task description" }),
	status: StatusEnum,
	activeForm: Type.Optional(
		Type.String({
			description: "Present continuous form for display during execution (e.g., 'Running tests', '테스트 실행 중')",
		}),
	),
	notes: Type.Optional(Type.String({ description: "Additional context or notes" })),
});

const TodoWriteParams = Type.Object(
	{
		todos: Type.Array(InputTask, { description: "The updated todo list" }),
	},
	{ additionalProperties: true },
);

type TodoWriteParamsType = Static<typeof TodoWriteParams>;

const todoStateStore = new Map<string, TodoState>();
const TODO_WIDGET_KEY = "todo-write";
const TODO_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TODO_SPINNER_INTERVAL_MS = 120;
let todoWidgetTimer: ReturnType<typeof setInterval> | undefined;
const todoWidgetHideTimerByKey = new Map<string, ReturnType<typeof setTimeout>>();
const todoWidgetMetaStore = new Map<string, { completedAt?: number; completedTurn?: number }>();
const todoWidgetAgentRunningStore = new Map<string, boolean>();
const todoTurnStore = new Map<string, number>();
const TODO_HIDE_COMPLETED_AFTER_TURNS = 2;
const TODO_HIDE_COMPLETED_AFTER_MS = 90_000;
const TODO_MAX_VISIBLE_COMPLETED_WIDGET_ITEMS = 2;
const TODO_STATE_ENTRY_TYPE = "todo-write-state";
const TODO_COMPACTION_REMINDER_TYPE = "todo-write-compaction-reminder";

function createEmptyState(): TodoState {
	return { tasks: [] };
}

function getTodoStateKey(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string {
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	return sessionFile ? `session:${sessionFile}` : `cwd:${ctx.cwd}`;
}

function cloneTasks(tasks: TodoTask[]): TodoTask[] {
	return tasks.map((task) => ({ ...task }));
}

function normalizeInProgressTask(tasks: TodoTask[]): void {
	if (tasks.length === 0) return;

	const inProgressTasks = tasks.filter((task) => task.status === "in_progress");
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = tasks.find((task) => task.status === "pending");
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

function hasRemainingTasks(state: TodoState): boolean {
	return state.tasks.some((task) => task.status === "pending" || task.status === "in_progress");
}

function getTodoTaskCount(state: TodoState): number {
	return state.tasks.length;
}

type TodoWidgetVisibility = {
	hidden: boolean;
	completionGraceActive: boolean;
	meta?: { completedAt: number; completedTurn: number };
};

export function getTodoWidgetVisibility(
	state: TodoState,
	meta: { completedAt?: number; completedTurn?: number } | undefined,
	currentTurn: number,
	now: number,
): TodoWidgetVisibility {
	if (getTodoTaskCount(state) === 0) return { hidden: true, completionGraceActive: false };
	// Reset completion tracking when tasks are still remaining — stale completedTurn causes immediate hide on next full completion
	if (hasRemainingTasks(state)) return { hidden: false, completionGraceActive: false };

	const completedTurn = meta?.completedTurn ?? currentTurn;
	const completedAt = meta?.completedAt ?? now;
	const elapsedTurns = Math.max(0, currentTurn - completedTurn);
	const elapsedMs = Math.max(0, now - completedAt);
	const hidden = elapsedTurns >= TODO_HIDE_COMPLETED_AFTER_TURNS || elapsedMs >= TODO_HIDE_COMPLETED_AFTER_MS;

	return {
		hidden,
		completionGraceActive: !hidden,
		meta: { completedAt, completedTurn },
	};
}

export function applyTodoWrite(todos: TodoWriteParamsType["todos"]): {
	state: TodoState;
} {
	const tasks: TodoTask[] = todos.map((todo, index) => ({
		id: `task-${index + 1}`,
		content: todo.content,
		status: todo.status,
		activeForm: todo.activeForm,
		notes: todo.notes,
	}));
	normalizeInProgressTask(tasks);
	return { state: { tasks } };
}

function renderTodoWidgetTaskLine(task: TodoTask): string {
	const isDone = task.status === "completed";
	const marker = task.status === "in_progress" ? "→" : isDone ? "●" : "○";
	const displayText = task.status === "in_progress" && task.activeForm ? task.activeForm : task.content;
	return isDone ? `~~${marker} ${displayText}` : `${marker} ${displayText}`;
}

export function renderTodoWidgetLines(state: TodoState): string[] {
	if (getTodoTaskCount(state) === 0) return [];

	const completedTasks = state.tasks.filter((task) => task.status === "completed");
	const hiddenCompletedCount = Math.max(0, completedTasks.length - TODO_MAX_VISIBLE_COMPLETED_WIDGET_ITEMS);
	const lines: string[] = [];
	let seenCompletedCount = 0;
	let insertedCompletedSummary = false;

	for (const task of state.tasks) {
		if (task.status !== "completed") {
			lines.push(renderTodoWidgetTaskLine(task));
			continue;
		}

		seenCompletedCount += 1;
		if (seenCompletedCount <= hiddenCompletedCount) {
			if (!insertedCompletedSummary) {
				lines.push(`완료 +${hiddenCompletedCount}`);
				insertedCompletedSummary = true;
			}
			continue;
		}

		lines.push(renderTodoWidgetTaskLine(task));
	}

	return lines;
}

export function renderTodoWriteSummary(state: TodoState): string {
	if (state.tasks.length === 0) return "Todo list cleared.";

	const remainingTasks = state.tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
	const doneCount = state.tasks.filter((task) => task.status === "completed").length;

	const lines: string[] = [];
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.id} ${task.content} [${task.status}]`);
		}
	}

	lines.push(`Progress: ${doneCount}/${state.tasks.length} tasks complete`);

	for (const task of state.tasks) {
		const marker = task.status === "completed" ? "✓" : task.status === "in_progress" ? "→" : "○";
		lines.push(`  ${marker} ${task.id} ${task.content}`);
	}

	return lines.join("\n");
}

function buildTodoTurnContext(state: TodoState): string | null {
	if (state.tasks.length === 0) return null;
	const summary = renderTodoWriteSummary(state);
	const activeTask = state.tasks.find((task) => task.status === "in_progress");
	const directive = activeTask
		? [
				`Active task: ${activeTask.id} ${activeTask.content}`,
				"When this task becomes done, your next action must be todo_write before any other tool call or response.",
			].join("\n")
		: hasRemainingTasks(state)
			? "There are remaining tasks but no active in_progress task. Before doing more work, call todo_write to select the next active task."
			: "All todo items are complete.";
	return [
		"[todo-reminder] internal todo_write state snapshot",
		"Source: in-memory session state maintained by the todo_write tool.",
		"Treat this as the latest authoritative todo status for the current turn.",
		"Do not contradict this snapshot. If progress/status differs, update todo_write first.",
		"",
		summary,
		"",
		directive,
	].join("\n");
}

type TodoStateEntryData = {
	tasks: TodoTask[];
	updatedAt: number;
};

function persistTodoWriteStateEntry(pi: Pick<ExtensionAPI, "appendEntry">, state: TodoState): void {
	pi.appendEntry<TodoStateEntryData>(TODO_STATE_ENTRY_TYPE, {
		tasks: cloneTasks(state.tasks),
		updatedAt: Date.now(),
	});
}

function clearTodoWriteState(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	pi: Pick<ExtensionAPI, "appendEntry">,
): void {
	const empty = createEmptyState();
	writeTodoWriteState(ctx, empty);
	persistTodoWriteStateEntry(pi, empty);
}

// ── Legacy persistence migration ────────────────────────────────────────────

type PersistedTodoStatus = TodoStatus | "abandoned";

type PersistedTodoTask = {
	id: string;
	content: string;
	status: PersistedTodoStatus;
	activeForm?: string;
	notes?: string;
};

type PersistedTodoStateEntryData = {
	tasks: PersistedTodoTask[];
	updatedAt: number;
};

function _isPersistedStatus(value: unknown): value is PersistedTodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned";
}

function isPersistedTodoTask(value: unknown): value is PersistedTodoTask {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.content === "string" &&
		_isPersistedStatus(candidate.status) &&
		(candidate.activeForm === undefined || typeof candidate.activeForm === "string") &&
		(candidate.notes === undefined || typeof candidate.notes === "string")
	);
}

/** Migrate legacy persisted tasks: map `abandoned` → `completed`. */
function migrateLegacyTasks(tasks: PersistedTodoTask[]): TodoTask[] {
	return tasks.map((task) => ({
		...task,
		status: task.status === "abandoned" ? "completed" : task.status,
	}));
}

function isPersistedTodoStateEntryData(value: unknown): value is PersistedTodoStateEntryData {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PersistedTodoStateEntryData>;
	return (
		typeof candidate.updatedAt === "number" &&
		Array.isArray(candidate.tasks) &&
		candidate.tasks.every((task) => isPersistedTodoTask(task))
	);
}

export function restoreTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TodoState {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== TODO_STATE_ENTRY_TYPE) continue;
		if (isPersistedTodoStateEntryData(entry.data)) {
			const tasks = migrateLegacyTasks(entry.data.tasks);
			normalizeInProgressTask(tasks);
			const restored = { tasks };
			writeTodoWriteState(ctx, restored);
			return restored;
		}
	}

	const empty = createEmptyState();
	writeTodoWriteState(ctx, empty);
	return empty;
}

export function buildPostCompactionTodoReminder(state: TodoState): string | null {
	if (!hasRemainingTasks(state)) return null;
	return [
		"[todo-reminder] todo_write still has remaining items after compaction.",
		"Please continue from the authoritative snapshot below.",
		"",
		renderTodoWriteSummary(state),
	].join("\n");
}

function readTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TodoState {
	const key = getTodoStateKey(ctx);
	const state = todoStateStore.get(key);
	return state ? { tasks: cloneTasks(state.tasks) } : createEmptyState();
}

function writeTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, state: TodoState): void {
	const key = getTodoStateKey(ctx);
	if (state.tasks.length === 0) {
		todoStateStore.delete(key);
		return;
	}
	todoStateStore.set(key, { tasks: cloneTasks(state.tasks) });
}

function hasInProgressTask(state: TodoState): boolean {
	return state.tasks.some((task) => task.status === "in_progress");
}

function clearTodoWidgetTimer(): void {
	if (!todoWidgetTimer) return;
	clearInterval(todoWidgetTimer);
	todoWidgetTimer = undefined;
}

function clearTodoWidgetHideTimer(key: string): void {
	const timer = todoWidgetHideTimerByKey.get(key);
	if (!timer) return;
	clearTimeout(timer);
	todoWidgetHideTimerByKey.delete(key);
}

function getTodoTurn(key: string): number {
	return todoTurnStore.get(key) ?? 0;
}

function incrementTodoTurn(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
	const key = getTodoStateKey(ctx);
	todoTurnStore.set(key, getTodoTurn(key) + 1);
}

function setTodoWidgetAgentRunning(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, running: boolean): void {
	const key = getTodoStateKey(ctx);
	todoWidgetAgentRunningStore.set(key, running);
}

async function syncTodoWidget(ctx: ExtensionContext, pi: Pick<ExtensionAPI, "appendEntry">): Promise<void> {
	if (!ctx.hasUI) return;

	const key = getTodoStateKey(ctx);
	const state = readTodoWriteState(ctx);
	const visibility = getTodoWidgetVisibility(state, todoWidgetMetaStore.get(key), getTodoTurn(key), Date.now());

	if (visibility.meta) {
		todoWidgetMetaStore.set(key, visibility.meta);
	} else {
		todoWidgetMetaStore.delete(key);
	}

	const lines = visibility.hidden ? [] : renderTodoWidgetLines(state);
	if (lines.length === 0) {
		// When hide conditions are met, clear state entirely
		// so that todo-reminder context is no longer injected into LLM turns.
		if (visibility.hidden && state.tasks.length > 0) {
			clearTodoWriteState(ctx, pi);
			todoWidgetMetaStore.delete(key);
		}
		clearTodoWidgetTimer();
		clearTodoWidgetHideTimer(key);
		ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
		return;
	}

	clearTodoWidgetHideTimer(key);
	if (visibility.completionGraceActive && !hasRemainingTasks(state) && visibility.meta?.completedAt !== undefined) {
		const elapsedMs = Math.max(0, Date.now() - visibility.meta.completedAt);
		const remainingMs = Math.max(0, TODO_HIDE_COMPLETED_AFTER_MS - elapsedMs);
		const hideTimer = setTimeout(() => {
			todoWidgetHideTimerByKey.delete(key);
			void syncTodoWidget(ctx, pi);
		}, remainingMs);
		todoWidgetHideTimerByKey.set(key, hideTimer);
	}

	ctx.ui.setWidget(TODO_WIDGET_KEY, (tui, theme) => {
		const renderedLines = [...lines];
		const hasRunning = hasInProgressTask(state) && (todoWidgetAgentRunningStore.get(key) ?? false);
		const content = new Text("", 0, 0);

		clearTodoWidgetTimer();
		if (hasRunning) {
			todoWidgetTimer = setInterval(() => tui.requestRender(), TODO_SPINNER_INTERVAL_MS);
		}

		return {
			render(width: number): string[] {
				const lineWidth = Math.max(8, width);
				const spinner =
					TODO_SPINNER_FRAMES[Math.floor(Date.now() / TODO_SPINNER_INTERVAL_MS) % TODO_SPINNER_FRAMES.length] ?? "•";
				const styledLines = renderedLines.map((line) => {
					if (line.startsWith("→ ")) {
						if (hasRunning) {
							const runningLine = `${spinner} ${line.slice(2)}`;
							return theme.bold(theme.fg("accent", truncateToWidth(runningLine, lineWidth)));
						}
						return theme.fg("accent", truncateToWidth(`○ ${line.slice(2)}`, lineWidth));
					}
					if (line.startsWith("~~")) {
						return theme.fg("dim", theme.strikethrough(truncateToWidth(line.slice(2), lineWidth)));
					}
					if (line.startsWith("...")) {
						return theme.fg("dim", truncateToWidth(line, lineWidth));
					}
					return theme.fg("toolOutput", truncateToWidth(line, lineWidth));
				});
				content.setText(styledLines.join("\n"));
				return content.render(width);
			},
			invalidate() {
				content.invalidate();
			},
		};
	});
}

export default function todoWriteExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description: `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and show the user your overall progress.

## When to Use
- Complex multi-step tasks requiring 3+ distinct steps
- User provides multiple tasks to be done
- Non-trivial tasks requiring careful planning

## When NOT to Use
- Single, straightforward task — just do it directly
- Trivial tasks completable in less than 3 steps
- Purely conversational or informational requests

## Rules
- Write todo content in Korean when practical
- Update task status in real-time as you work
- Mark tasks complete IMMEDIATELY after finishing — don't batch completions
- Exactly ONE task should be in_progress at any time
- Complete current tasks before starting new ones
- Remove tasks that are no longer relevant
- ONLY mark completed when FULLY accomplished — if blocked, keep as in_progress
- If requirements change mid-task, update the todo list before continuing

## Task Fields
- content: Imperative form (e.g., "테스트 실행", "Run tests")
- status: pending | in_progress | completed
- activeForm: (optional) Present continuous form for display (e.g., "테스트 실행 중", "Running tests")
- notes: (optional) Additional context`,
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const applied = applyTodoWrite(params.todos);
			const summary = renderTodoWriteSummary(applied.state);
			writeTodoWriteState(ctx, applied.state);
			persistTodoWriteStateEntry(pi, applied.state);
			await syncTodoWidget(ctx, pi);
			return {
				content: [{ type: "text" as const, text: summary }],
				details: { tasks: applied.state.tasks, summary },
			};
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return new Text("", 0, 0);
			const details = result.details as { summary?: unknown } | undefined;
			const summary = typeof details?.summary === "string" ? details.summary : "";
			return new Text(summary ? theme.fg("toolOutput", summary) : "", 0, 0);
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = readTodoWriteState(ctx);
		if (state.tasks.length === 0) return;

		// If hide conditions are met, clear state so no reminder is injected
		const key = getTodoStateKey(ctx);
		const visibility = getTodoWidgetVisibility(state, todoWidgetMetaStore.get(key), getTodoTurn(key), Date.now());
		if (visibility.hidden) {
			clearTodoWriteState(ctx, pi);
			todoWidgetMetaStore.delete(key);
			return;
		}

		const content = buildTodoTurnContext(state);
		if (!content) return;
		return {
			message: {
				customType: "todo-write-context",
				content,
				display: false,
				details: { summary: renderTodoWriteSummary(state) },
			},
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		setTodoWidgetAgentRunning(ctx, true);
		await syncTodoWidget(ctx, pi);
	});

	pi.on("agent_end", async (_event, ctx) => {
		setTodoWidgetAgentRunning(ctx, false);
		await syncTodoWidget(ctx, pi);
	});

	pi.on("session_start", async (_event, ctx) => {
		setTodoWidgetAgentRunning(ctx, false);
		restoreTodoWriteState(ctx);
		await syncTodoWidget(ctx, pi);
	});

	pi.on("session_tree", async (_event, ctx) => {
		setTodoWidgetAgentRunning(ctx, false);
		restoreTodoWriteState(ctx);
		await syncTodoWidget(ctx, pi);
	});

	pi.on("session_compact", async (_event, ctx) => {
		const state = restoreTodoWriteState(ctx);
		await syncTodoWidget(ctx, pi);
		const reminder = buildPostCompactionTodoReminder(state);
		if (!reminder) return;

		if (ctx.hasUI) {
			ctx.ui.notify("Todo reminder: remaining items still exist after compaction.", "info");
		}

		pi.sendMessage(
			{
				customType: TODO_COMPACTION_REMINDER_TYPE,
				content: reminder,
				display: true,
				details: { summary: renderTodoWriteSummary(state) },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.on("message_end", async (_event, ctx) => {
		incrementTodoTurn(ctx);
		await syncTodoWidget(ctx, pi);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const key = getTodoStateKey(ctx);
		clearTodoWidgetTimer();
		clearTodoWidgetHideTimer(key);
		todoWidgetMetaStore.delete(key);
		todoWidgetAgentRunningStore.delete(key);
		todoTurnStore.delete(key);
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
	});
}
