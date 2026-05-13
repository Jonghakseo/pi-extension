import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

type TodoOverlayRecord = {
	opening: boolean;
	component?: TodoOverlayComponent;
	handle?: OverlayHandle;
	close?: () => void;
};

const StatusEnum = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
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
const todoOverlayStore = new Map<string, TodoOverlayRecord>();
const todoOverlayMetaStore = new Map<string, { completedAt?: number; completedTurn?: number }>();
const todoOverlayAgentRunningStore = new Map<string, boolean>();
const todoOverlayHiddenStore = new Map<string, boolean>();
const todoTurnStore = new Map<string, number>();
const TODO_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TODO_SPINNER_INTERVAL_MS = 120;
const TODO_HIDE_COMPLETED_AFTER_TURNS = 2;
const TODO_HIDE_COMPLETED_AFTER_MS = 90_000;
const TODO_STATE_ENTRY_TYPE = "todo-write-overlay-state";
const TODO_COMPACTION_REMINDER_TYPE = "todo-write-overlay-compaction-reminder";

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

function cloneState(state: TodoState): TodoState {
	return { tasks: cloneTasks(state.tasks) };
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

function hasInProgressTask(state: TodoState): boolean {
	return state.tasks.some((task) => task.status === "in_progress");
}

type TodoOverlayVisibility = {
	hidden: boolean;
	completionGraceActive: boolean;
	meta?: { completedAt: number; completedTurn: number };
};

export function getTodoOverlayVisibility(
	state: TodoState,
	meta: { completedAt?: number; completedTurn?: number } | undefined,
	currentTurn: number,
	now: number,
): TodoOverlayVisibility {
	if (state.tasks.length === 0) return { hidden: true, completionGraceActive: false };
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

export function renderTodoOverlayPlainLines(state: TodoState): string[] {
	return state.tasks.map((task) => {
		const marker = task.status === "completed" ? "✓" : task.status === "in_progress" ? "→" : "○";
		const displayText = task.status === "in_progress" && task.activeForm ? task.activeForm : task.content;
		return `${marker} ${displayText}`;
	});
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
	const activeLine = activeTask
		? [
				`현재 작업: ${activeTask.id} ${activeTask.activeForm ?? activeTask.content}`,
				"이 작업이 끝났다면 다른 도구 호출이나 응답보다 먼저 todo_write로 상태를 갱신하세요.",
			]
		: hasRemainingTasks(state)
			? [
					"남은 작업이 있지만 현재 in_progress 상태의 항목이 없습니다. 계속 진행하기 전에 todo_write로 다음 활성 작업을 지정하세요.",
				]
			: [];

	return [
		"[todo-reminder] 현재 todo_write 상태 스냅샷",
		"출처: todo_write_overlay 도구가 유지하는 세션 메모리 상태입니다.",
		"현재 턴에서는 이 내용을 가장 최신의 기준 상태로 간주하세요.",
		"이 스냅샷과 모순되게 설명하지 말고, 상태가 달라졌다면 먼저 todo_write를 업데이트하세요.",
		"",
		summary,
		...(activeLine.length > 0 ? ["", ...activeLine] : []),
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
	const candidate = value as Partial<PersistedTodoTask>;
	return (
		typeof candidate.id === "string" && typeof candidate.content === "string" && _isPersistedStatus(candidate.status)
	);
}

function migrateLegacyTasks(tasks: PersistedTodoTask[]): TodoTask[] {
	const migrated = tasks.map((task) => ({
		id: task.id,
		content: task.content,
		status: task.status === "abandoned" ? "completed" : task.status,
		activeForm: task.activeForm,
		notes: task.notes,
	}));
	normalizeInProgressTask(migrated);
	return migrated;
}

function isPersistedTodoStateEntryData(value: unknown): value is PersistedTodoStateEntryData {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PersistedTodoStateEntryData>;
	return (
		Array.isArray(candidate.tasks) &&
		typeof candidate.updatedAt === "number" &&
		candidate.tasks.every((task) => isPersistedTodoTask(task))
	);
}

export function restoreTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TodoState {
	const branch = ctx.sessionManager.getBranch?.() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== TODO_STATE_ENTRY_TYPE) continue;
		if (isPersistedTodoStateEntryData(entry.data)) {
			const restored = { tasks: migrateLegacyTasks(entry.data.tasks) };
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
		"다음 응답/도구 호출 전에 이 상태를 이어서 사용하세요.",
		"",
		renderTodoWriteSummary(state),
	].join("\n");
}

function readTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): TodoState {
	const key = getTodoStateKey(ctx);
	const state = todoStateStore.get(key) ?? createEmptyState();
	return { tasks: cloneTasks(state.tasks) };
}

function writeTodoWriteState(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, state: TodoState): void {
	const key = getTodoStateKey(ctx);
	todoStateStore.set(key, { tasks: cloneTasks(state.tasks) });
}

function getTodoTurn(key: string): number {
	return todoTurnStore.get(key) ?? 0;
}

function incrementTodoTurn(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void {
	const key = getTodoStateKey(ctx);
	todoTurnStore.set(key, getTodoTurn(key) + 1);
}

function setTodoOverlayAgentRunning(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, running: boolean): void {
	const key = getTodoStateKey(ctx);
	todoOverlayAgentRunningStore.set(key, running);
}

export type TodoOverlayCommandAction = "show" | "hide" | "status" | "invalid";

export function parseTodoOverlayCommand(args: string): TodoOverlayCommandAction {
	const action = args.trim().toLowerCase();
	if (action === "") return "status";
	if (action === "show" || action === "hide") return action;
	return "invalid";
}

function isTodoOverlayHidden(key: string): boolean {
	return todoOverlayHiddenStore.get(key) ?? false;
}

function setTodoOverlayHidden(key: string, hidden: boolean): void {
	todoOverlayHiddenStore.set(key, hidden);
}

function hideTodoOverlay(key: string): void {
	const record = todoOverlayStore.get(key);
	if (!record) return;
	record.close?.();
	record.handle?.hide();
	record.component?.dispose();
	todoOverlayStore.delete(key);
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "...", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

class TodoOverlayComponent {
	private state: TodoState;
	private agentRunning: boolean;
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(
		private tui: TUI,
		private theme: Theme,
		state: TodoState,
		agentRunning: boolean,
	) {
		this.state = cloneState(state);
		this.agentRunning = agentRunning;
		this.syncTimer();
	}

	setState(state: TodoState): void {
		this.state = cloneState(state);
		this.syncTimer();
		this.tui.requestRender();
	}

	setAgentRunning(running: boolean): void {
		this.agentRunning = running;
		this.syncTimer();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const isActivelyRunning = this.agentRunning && hasInProgressTask(this.state);
		const border = (text: string) => {
			const colored = this.theme.fg(
				isActivelyRunning ? "accent" : hasRemainingTasks(this.state) ? "borderAccent" : "borderMuted",
				text,
			);
			return isActivelyRunning ? this.theme.bold(colored) : colored;
		};
		const row = (text: string) => `${border("│")}${padAnsi(text, innerWidth)}${border("│")}`;
		const doneCount = this.state.tasks.filter((task) => task.status === "completed").length;
		const totalCount = this.state.tasks.length;
		const title = this.theme.fg("accent", this.theme.bold(" TODO "));
		const progress = totalCount === 0 ? "0/0" : `${doneCount}/${totalCount}`;
		const progressText = this.theme.fg("dim", ` ${progress} 완료 `);
		const titleWidth = visibleWidth(title) + visibleWidth(progressText);
		const titlePad = Math.max(0, innerWidth - titleWidth);
		const lines = [`${border("╭")}${title}${border("─".repeat(titlePad))}${progressText}${border("╮")}`];

		if (this.state.tasks.length === 0) {
			lines.push(row(` ${this.theme.fg("dim", "할 일 없음")}`));
		} else {
			for (const task of this.state.tasks) {
				lines.push(row(this.renderTaskLine(task)));
			}
		}

		lines.push(`${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`);
		return lines;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private renderTaskLine(task: TodoTask): string {
		const displayText = task.status === "in_progress" && task.activeForm ? task.activeForm : task.content;
		if (task.status === "completed") {
			return ` ${this.theme.fg("success", "✓")} ${this.theme.fg("dim", this.theme.strikethrough(displayText))}`;
		}
		if (task.status === "in_progress") {
			const marker = this.agentRunning ? this.currentSpinner() : "→";
			return ` ${this.theme.fg("accent", marker)} ${this.theme.fg("accent", this.theme.bold(displayText))}`;
		}
		return ` ${this.theme.fg("muted", "○")} ${this.theme.fg("toolOutput", displayText)}`;
	}

	private currentSpinner(): string {
		return TODO_SPINNER_FRAMES[Math.floor(Date.now() / TODO_SPINNER_INTERVAL_MS) % TODO_SPINNER_FRAMES.length] ?? "•";
	}

	private syncTimer(): void {
		const shouldRun = !this.disposed && this.agentRunning && hasInProgressTask(this.state);
		if (shouldRun && !this.timer) {
			this.timer = setInterval(() => this.tui.requestRender(), TODO_SPINNER_INTERVAL_MS);
			return;
		}
		if (!shouldRun && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

function showOrUpdateTodoOverlay(ctx: ExtensionContext, key: string, state: TodoState): void {
	const agentRunning = todoOverlayAgentRunningStore.get(key) ?? false;
	const record = todoOverlayStore.get(key);
	if (record?.component) {
		record.component.setState(state);
		record.component.setAgentRunning(agentRunning);
		return;
	}
	if (record?.opening) return;

	todoOverlayStore.set(key, { opening: true });
	const initialState = cloneState(state);
	const overlayPromise = ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const component = new TodoOverlayComponent(tui, theme, initialState, agentRunning);
			const current = todoOverlayStore.get(key) ?? { opening: false };
			todoOverlayStore.set(key, { ...current, opening: false, component, close: done });
			return component;
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-right",
				width: 42,
				maxHeight: "60%",
				margin: { top: 1, right: 2 },
				nonCapturing: true,
				visible: (termWidth) => termWidth >= 70,
			},
			onHandle: (handle) => {
				const current = todoOverlayStore.get(key) ?? { opening: false };
				todoOverlayStore.set(key, { ...current, handle });
			},
		},
	);
	void overlayPromise
		.finally(() => {
			const current = todoOverlayStore.get(key);
			current?.component?.dispose();
			todoOverlayStore.delete(key);
		})
		.catch(() => {});
}

async function syncTodoOverlay(ctx: ExtensionContext, pi: Pick<ExtensionAPI, "appendEntry">): Promise<void> {
	if (!ctx.hasUI) return;

	const key = getTodoStateKey(ctx);
	const state = readTodoWriteState(ctx);
	const visibility = getTodoOverlayVisibility(state, todoOverlayMetaStore.get(key), getTodoTurn(key), Date.now());

	if (visibility.meta) {
		todoOverlayMetaStore.set(key, visibility.meta);
	} else {
		todoOverlayMetaStore.delete(key);
	}

	if (visibility.hidden || state.tasks.length === 0) {
		if (visibility.hidden && state.tasks.length > 0) {
			clearTodoWriteState(ctx, pi);
			todoOverlayMetaStore.delete(key);
		}
		hideTodoOverlay(key);
		return;
	}

	if (isTodoOverlayHidden(key)) {
		hideTodoOverlay(key);
		return;
	}

	showOrUpdateTodoOverlay(ctx, key, state);
}

export default function todoWriteOverlayExtension(pi: ExtensionAPI): void {
	pi.registerCommand("todo-overlay", {
		description: "Show or hide the todo overlay. Usage: /todo-overlay show|hide",
		getArgumentCompletions(prefix: string) {
			const filtered = ["show", "hide"].filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		async handler(args, ctx) {
			const key = getTodoStateKey(ctx);
			const action = parseTodoOverlayCommand(args);

			if (action === "invalid") {
				ctx.ui.notify("사용법: /todo-overlay show 또는 /todo-overlay hide", "warning");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(`todo overlay: ${isTodoOverlayHidden(key) ? "hidden" : "shown"}`, "info");
				return;
			}

			setTodoOverlayHidden(key, action === "hide");
			if (action === "hide") {
				hideTodoOverlay(key);
				ctx.ui.notify("todo overlay를 숨겼습니다. /todo-overlay show로 다시 표시할 수 있습니다.", "info");
				return;
			}

			await syncTodoOverlay(ctx, pi);
			ctx.ui.notify("todo overlay를 표시합니다.", "info");
		},
	});

	pi.registerTool({
		name: "todo_write",
		label: "할 일 관리",
		description: `현재 코딩 세션의 구조화된 작업 목록을 만들고 관리합니다. 진행 상황을 추적하고, 복잡한 요청을 단계로 나누고, 사용자에게 현재 무엇을 하고 있는지 우측 상단 오버레이로 보여줄 때 사용하세요.

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
			await syncTodoOverlay(ctx, pi);
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

		const key = getTodoStateKey(ctx);
		const visibility = getTodoOverlayVisibility(state, todoOverlayMetaStore.get(key), getTodoTurn(key), Date.now());
		if (visibility.hidden) {
			clearTodoWriteState(ctx, pi);
			todoOverlayMetaStore.delete(key);
			hideTodoOverlay(key);
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
		setTodoOverlayAgentRunning(ctx, true);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("agent_end", async (_event, ctx) => {
		setTodoOverlayAgentRunning(ctx, false);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("session_start", async (_event, ctx) => {
		setTodoOverlayAgentRunning(ctx, false);
		restoreTodoWriteState(ctx);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("session_tree", async (_event, ctx) => {
		setTodoOverlayAgentRunning(ctx, false);
		restoreTodoWriteState(ctx);
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("session_compact", async (_event, ctx) => {
		const state = restoreTodoWriteState(ctx);
		await syncTodoOverlay(ctx, pi);
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
		await syncTodoOverlay(ctx, pi);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const key = getTodoStateKey(ctx);
		hideTodoOverlay(key);
		todoOverlayMetaStore.delete(key);
		todoOverlayAgentRunningStore.delete(key);
		todoOverlayHiddenStore.delete(key);
		todoTurnStore.delete(key);
	});
}
