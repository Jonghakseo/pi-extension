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
	description: "작업 상태",
});

const InputTask = Type.Object({
	content: Type.String({ description: "작업 설명" }),
	status: StatusEnum,
	activeForm: Type.Optional(
		Type.String({
			description: "진행 중 표시용 현재진행형 문구 (예: '테스트 실행 중')",
		}),
	),
	notes: Type.Optional(Type.String({ description: "추가 맥락 또는 메모" })),
});

const TodoWriteParams = Type.Object(
	{
		todos: Type.Array(InputTask, { description: "업데이트된 todo 목록" }),
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
const TODO_MAX_VISIBLE_COMPLETED_WIDGET_ITEMS = 1;
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
	if (state.tasks.length === 0) return "할 일 목록을 비웠습니다.";

	const remainingTasks = state.tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
	const doneCount = state.tasks.filter((task) => task.status === "completed").length;

	const lines: string[] = [];
	if (remainingTasks.length === 0) {
		lines.push("남은 항목: 없음.");
	} else {
		lines.push(`남은 항목 (${remainingTasks.length}개):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.id} ${task.content} [${task.status}]`);
		}
	}

	lines.push(`진행률: ${doneCount}/${state.tasks.length} 완료`);

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
				`현재 작업: ${activeTask.id} ${activeTask.content}`,
				"이 작업이 끝났다면 다른 도구 호출이나 응답보다 먼저 todo_write로 상태를 갱신하세요.",
			].join("\n")
		: hasRemainingTasks(state)
			? "남은 작업이 있지만 현재 in_progress 상태의 항목이 없습니다. 계속 진행하기 전에 todo_write로 다음 활성 작업을 지정하세요."
			: "모든 todo 항목이 완료되었습니다.";
	return [
		"[todo-reminder] 현재 todo_write 상태 스냅샷",
		"출처: todo_write 도구가 유지하는 세션 메모리 상태입니다.",
		"현재 턴에서는 이 내용을 가장 최신의 기준 상태로 간주하세요.",
		"이 스냅샷과 모순되게 설명하지 말고, 상태가 달라졌다면 먼저 todo_write를 업데이트하세요.",
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
		"[todo-reminder] compaction 이후에도 todo_write에 아직 남은 항목이 있습니다.",
		"아래의 기준 스냅샷을 바탕으로 이어서 작업하세요.",
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
		label: "할 일 관리",
		description: `현재 코딩 세션의 구조화된 작업 목록을 만들고 관리합니다. 진행 상황을 추적하고, 복잡한 요청을 단계로 나누고, 사용자에게 현재 무엇을 하고 있는지 보여줄 때 사용하세요.

## 언제 사용할까
- 3단계 이상의 복잡한 멀티스텝 작업
- 사용자가 여러 작업을 한 번에 요청한 경우
- 구현/디버깅 전에 계획 정리가 필요한 비단순 작업

## 언제 쓰지 말까
- 단순한 한 가지 작업이면 바로 수행
- 3단계 미만으로 끝나는 아주 간단한 작업
- 순수 대화형/정보 제공성 응답만 필요한 경우

## 규칙
- 가능하면 todo 내용은 한글로 간결하게 작성
- 작업하면서 상태를 실시간으로 갱신
- 작업이 끝나면 즉시 completed로 변경하고 몰아서 처리하지 않기
- in_progress 상태는 정확히 하나만 유지
- 새 작업을 시작하기 전에 현재 작업을 정리
- 더 이상 의미 없는 항목은 목록에서 제거
- 완전히 끝난 일만 completed로 표시하고, 막혔으면 in_progress 유지
- 요구사항이 바뀌면 계속 진행하기 전에 todo 목록부터 갱신

## 필드 설명
- content: 명령형 작업 문구 (예: "테스트 실행")
- status: pending | in_progress | completed
- activeForm: (선택) 진행 중 표시 문구 (예: "테스트 실행 중")
- notes: (선택) 추가 맥락`,
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
			ctx.ui.notify("todo 알림: compaction 이후에도 남은 항목이 있습니다.", "info");
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
