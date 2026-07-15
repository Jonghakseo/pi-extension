import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { parseDelayArgs, parseDurationMs } from "./parse.ts";

const STATUS_KEY = "delay";

interface DelayTask {
	id: string;
	prompt: string;
	createdAt: number;
	dueAt: number;
	timer: ReturnType<typeof setTimeout>;
	ctx: ExtensionContext;
}

const DelayParamsSchema = Type.Object({
	delay: Type.String({ description: "Delay duration such as 30s, 5m, 1h, 1h30m, 2시간." }),
	prompt: Type.String({ description: "Prompt text to submit to the agent after the delay (triggers a turn)." }),
	id: Type.Optional(Type.String({ description: "Optional task id. Auto-generated when omitted." })),
});

interface DelayToolParams {
	delay: string;
	prompt: string;
	id?: string;
}

const tasks = new Map<string, DelayTask>();
let nextId = 1;
let latestCtx: ExtensionContext | undefined;
let api: ExtensionAPI | undefined;
let statusInterval: ReturnType<typeof setInterval> | undefined;

function formatKoreanDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}초`;
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}분`;

	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (minutes === 0) return `${hours}시간`;
	return `${hours}시간 ${minutes}분`;
}

function allocateId(requested?: string): string {
	const base = requested?.trim() || `delay-${nextId++}`;
	if (!/^[a-zA-Z0-9._-]+$/.test(base)) throw new Error(`Invalid delay id: ${base}`);
	if (!tasks.has(base)) return base;
	if (requested) throw new Error(`Delay id already exists: ${base}`);
	return allocateId(`delay-${nextId++}`);
}

function preview(text: string, max = 80): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function formatTask(task: DelayTask, now = Date.now()): string {
	const remaining = Math.max(0, task.dueAt - now);
	const dueTime = new Date(task.dueAt).toLocaleTimeString("ko-KR", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return `${task.id} · ${formatKoreanDuration(remaining)} 후 (${dueTime}) · ${preview(task.prompt)}`;
}

function sortedTasks(): DelayTask[] {
	return [...tasks.values()].sort((a, b) => a.dueAt - b.dueAt);
}

function listTasks(): string {
	if (tasks.size === 0) return "예약된 delay가 없어요.";
	const now = Date.now();
	return ["예약된 delay:", ...sortedTasks().map((task) => `- ${formatTask(task, now)}`)].join("\n");
}

function paintStatus(ctx: ExtensionContext, text: string): string {
	const theme = ctx.ui.theme as { fg?: unknown } | undefined;
	return typeof theme?.fg === "function" ? theme.fg("accent", text) : text;
}

function refreshStatus(): void {
	const ctx = latestCtx;
	if (!ctx?.hasUI) return;
	try {
		if (tasks.size === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const next = [...tasks.values()].sort((a, b) => a.dueAt - b.dueAt)[0];
		ctx.ui.setStatus(
			STATUS_KEY,
			paintStatus(ctx, `⏰ ${tasks.size} · ${formatKoreanDuration(next.dueAt - Date.now())}`),
		);
	} catch {}
}

function ensureStatusTicker(): void {
	if (statusInterval) return;
	statusInterval = setInterval(refreshStatus, 1000);
}

function stopStatusTickerIfIdle(): void {
	if (tasks.size > 0 || !statusInterval) return;
	clearInterval(statusInterval);
	statusInterval = undefined;
}

type SubmitReason = "due" | "manual";

function removeTask(task: DelayTask): boolean {
	if (tasks.get(task.id) !== task) return false;
	clearTimeout(task.timer);
	tasks.delete(task.id);
	refreshStatus();
	stopStatusTickerIfIdle();
	return true;
}

function submitTask(task: DelayTask, reason: SubmitReason): boolean {
	if (!removeTask(task)) return false;
	try {
		if (!api) throw new Error("delay runtime is not initialized.");
		const idle = task.ctx.isIdle();
		// idle이면 즉시 턴을 트리거하고, 작업 중이면 현재 턴 종료 후 실행되도록 followUp으로 큐잉한다.
		api.sendUserMessage(task.prompt, idle ? undefined : { deliverAs: "followUp" });
		if (task.ctx.hasUI) {
			const message =
				reason === "manual"
					? idle
						? `▶ ${task.id} 프롬프트를 바로 실행했어요.`
						: `▶ ${task.id} 프롬프트를 followUp으로 바로 보냈어요.`
					: idle
						? `⏰ ${task.id} 시간이 되어 프롬프트를 실행했어요.`
						: `⏰ ${task.id} 작업 중이라 followUp으로 예약했어요.`;
			task.ctx.ui.notify(message, "info");
		}
	} catch (err) {
		if (task.ctx.hasUI) {
			const message = err instanceof Error ? err.message : String(err);
			task.ctx.ui.notify(`⏰ ${task.id} 프롬프트 실행 실패: ${message}`, "error");
		}
	}
	return true;
}

function scheduleDelay(ctx: ExtensionContext, delayMs: number, prompt: string, requestedId?: string): DelayTask {
	if (!ctx.hasUI) throw new Error("delay requires an interactive UI so it can submit the prompt to the agent.");
	latestCtx = ctx;
	const id = allocateId(requestedId);
	const createdAt = Date.now();
	const task: DelayTask = {
		id,
		prompt,
		createdAt,
		dueAt: createdAt + delayMs,
		timer: setTimeout(() => submitTask(task, "due"), delayMs),
		ctx,
	};
	tasks.set(id, task);
	ensureStatusTicker();
	refreshStatus();
	return task;
}

function rescheduleTask(task: DelayTask, delayMs: number, prompt: string): boolean {
	if (tasks.get(task.id) !== task) return false;
	clearTimeout(task.timer);
	const createdAt = Date.now();
	const updatedTask: DelayTask = {
		id: task.id,
		prompt,
		createdAt,
		dueAt: createdAt + delayMs,
		timer: setTimeout(() => submitTask(updatedTask, "due"), delayMs),
		ctx: task.ctx,
	};
	tasks.set(updatedTask.id, updatedTask);
	refreshStatus();
	return true;
}

function cancelTask(id: string): boolean {
	const task = tasks.get(id);
	if (!task) return false;
	clearTimeout(task.timer);
	tasks.delete(id);
	refreshStatus();
	stopStatusTickerIfIdle();
	return true;
}

function cancelAll(): number {
	const count = tasks.size;
	for (const task of tasks.values()) clearTimeout(task.timer);
	tasks.clear();
	refreshStatus();
	stopStatusTickerIfIdle();
	return count;
}

function helpText(): string {
	return [
		"Usage:",
		"  /delay <duration> <prompt>     지연 후 프롬프트를 제출하고 턴을 트리거",
		"  /delay list                    예약 목록을 텍스트로 보기",
		"  /delay-list                    예약을 골라 바로 보내기/수정/취소",
		"  /delay-cancel [id|all]         예약 취소 (id 생략 시 전체 취소)",
		"",
		"Examples:",
		"  /delay 5m 상태 확인해줘",
		"  /delay 1h30m 회의록 정리 시작",
		"  /delay 2시간 배포 결과 확인",
		"",
		"Duration units: ms, s, m, h, d, 초, 분, 시간, 일",
	].join("\n");
}

function scheduleFromCommand(args: string, ctx: ExtensionContext): string {
	const parsed = parseDelayArgs(args);
	if ("error" in parsed) return parsed.error;
	const task = scheduleDelay(ctx, parsed.delayMs, parsed.prompt);
	return `✓ ${task.id} 예약됨: ${formatKoreanDuration(parsed.delayMs)} 후 제출 · ${preview(task.prompt)}`;
}

async function handleDelayCommand(args: string, ctx: ExtensionContext): Promise<string> {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "help" || trimmed === "--help" || trimmed === "-h") return helpText();
	if (trimmed === "list" || trimmed === "ls" || trimmed === "status") return listTasks();

	return scheduleFromCommand(trimmed, ctx);
}

function handleDelayCancelCommand(args: string): string {
	const target = args.trim();
	if (!target || target === "all") return `✓ ${cancelAll()}개의 delay를 취소했어요.`;
	return cancelTask(target) ? `✓ ${target} 예약을 취소했어요.` : `예약을 찾을 수 없어요: ${target}`;
}

function notifyTaskUnavailable(ctx: ExtensionContext, id: string): void {
	ctx.ui.notify(`예약이 변경되었거나 이미 실행/취소되었어요: ${id}`, "warning");
}

async function handleDelayListCommand(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/delay-list는 대화형 UI에서만 사용할 수 있어요.", "warning");
		return;
	}

	const availableTasks = sortedTasks();
	if (availableTasks.length === 0) {
		ctx.ui.notify("예약된 delay가 없어요.", "info");
		return;
	}

	const now = Date.now();
	const taskOptions = availableTasks.map((task) => formatTask(task, now));
	const selectedTaskLabel = await ctx.ui.select("예약된 delay를 선택하세요", taskOptions);
	if (selectedTaskLabel === undefined) return;
	const selectedTask = availableTasks[taskOptions.indexOf(selectedTaskLabel)];
	if (!selectedTask || tasks.get(selectedTask.id) !== selectedTask) {
		notifyTaskUnavailable(ctx, selectedTask?.id ?? selectedTaskLabel);
		return;
	}

	const action = await ctx.ui.select(`${selectedTask.id} · ${preview(selectedTask.prompt)}`, [
		"지금 보내기",
		"수정",
		"예약 취소",
	]);
	if (action === undefined) return;
	if (tasks.get(selectedTask.id) !== selectedTask) {
		notifyTaskUnavailable(ctx, selectedTask.id);
		return;
	}

	if (action === "지금 보내기") {
		submitTask(selectedTask, "manual");
		return;
	}
	if (action === "예약 취소") {
		cancelTask(selectedTask.id);
		ctx.ui.notify(`✓ ${selectedTask.id} 예약을 취소했어요.`, "info");
		return;
	}
	if (action !== "수정") return;

	const remaining = Math.max(0, selectedTask.dueAt - Date.now());
	const delayText = await ctx.ui.input(
		`새 지연 시간 · 현재 약 ${formatKoreanDuration(remaining)} 남음`,
		"예: 30s, 5m, 1h30m, 2시간",
	);
	if (delayText === undefined) return;
	const delayMs = parseDurationMs(delayText);
	if (delayMs === undefined) {
		ctx.ui.notify("지연 시간을 해석할 수 없어요. 예: 30s, 5m, 1h30m, 2시간", "warning");
		return;
	}
	if (tasks.get(selectedTask.id) !== selectedTask) {
		notifyTaskUnavailable(ctx, selectedTask.id);
		return;
	}

	const editedPrompt = await ctx.ui.editor(`메시지 수정 · ${selectedTask.id}`, selectedTask.prompt);
	if (editedPrompt === undefined) return;
	const prompt = editedPrompt.trim();
	if (!prompt) {
		ctx.ui.notify("메시지는 비워둘 수 없어요.", "warning");
		return;
	}
	if (!rescheduleTask(selectedTask, delayMs, prompt)) {
		notifyTaskUnavailable(ctx, selectedTask.id);
		return;
	}
	ctx.ui.notify(`✓ ${selectedTask.id} 수정됨: 지금부터 ${formatKoreanDuration(delayMs)} 후 제출`, "info");
}

function clearAllTimers(): void {
	for (const task of tasks.values()) clearTimeout(task.timer);
	tasks.clear();
	if (statusInterval) clearInterval(statusInterval);
	statusInterval = undefined;
}

export default function (pi: ExtensionAPI) {
	api = pi;
	pi.registerCommand("delay", {
		description: "지정한 시간 후 프롬프트를 제출하고 턴 트리거: /delay 5m <프롬프트>",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (trimmed.includes(" ")) return null;
			return ["list", "5m", "30s", "1h"]
				.filter((value) => value.startsWith(trimmed))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const message = await handleDelayCommand(args ?? "", ctx);
			ctx.ui.notify(
				message,
				message.startsWith("✓") || message.startsWith("예약된") || message.startsWith("Usage") ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("delay-list", {
		description: "예약된 delay를 골라 바로 보내기, 수정 또는 취소",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			await handleDelayListCommand(ctx);
		},
	});

	pi.registerCommand("delay-cancel", {
		description: "delay 예약 취소. 사용법: /delay-cancel [id|all] (인자 생략 시 전체 취소)",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			const items = [
				{ value: "all", label: "all" },
				...[...tasks.keys()].map((id) => ({ value: id, label: id })),
			].filter((item) => item.value.startsWith(trimmed));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const message = handleDelayCancelCommand(args ?? "");
			ctx.ui.notify(message, message.startsWith("✓") ? "info" : "warning");
		},
	});

	pi.registerTool({
		name: "delay",
		label: "Delay",
		description:
			"Schedule a prompt to be submitted to the agent after a short delay, triggering a new turn when it fires. Use for one-shot reminders like 5m, 1h, or 2시간. The user can manage scheduled prompts with /delay-list or cancel directly with /delay-cancel <id>.",
		promptSnippet: "Submit a prompt to the agent after a delay, e.g. delay=5m prompt='check status'.",
		promptGuidelines: [
			"Use delay only when the user explicitly asks to run a prompt later in the same interactive session.",
			"When the delay fires the prompt is submitted as a user message and triggers a turn (followUp-queued if the agent is busy), not just inserted into the editor.",
			"For recurring or persistent headless scheduled jobs, use cron instead of delay.",
			"Tell the user the returned id. They can manage it interactively with `/delay-list`, cancel it with `/delay-cancel <id>`, or cancel all with `/delay-cancel`.",
		],
		parameters: DelayParamsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as DelayToolParams;
			const delayMs = parseDurationMs(params.delay);
			if (delayMs === undefined) {
				return {
					content: [{ type: "text" as const, text: "Invalid delay. Use forms like 30s, 5m, 1h, 1h30m, 2시간." }],
					details: {},
					isError: true,
				};
			}
			if (!params.prompt.trim()) {
				return {
					content: [{ type: "text" as const, text: "prompt is required." }],
					details: {},
					isError: true,
				};
			}

			const task = scheduleDelay(ctx, delayMs, params.prompt.trim(), params.id);
			return {
				content: [
					{
						type: "text" as const,
						text: `✓ ${task.id} scheduled: prompt will be submitted ${formatKoreanDuration(delayMs)} later (triggers a turn). Cancel with /delay-cancel ${task.id}`,
					},
				],
				details: { id: task.id, dueAt: new Date(task.dueAt).toISOString(), prompt: task.prompt },
			};
		},
		renderCall(args, theme) {
			const params = args as Partial<DelayToolParams>;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("delay "))}${theme.fg("accent", params.delay ?? "?")} ${theme.fg("dim", preview(params.prompt ?? ""))}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme, context) {
			const raw = result.content[0];
			const text = raw?.type === "text" ? raw.text : "(no output)";
			return new Text(context.isError ? theme.fg("error", text) : text, 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		refreshStatus();
	});

	pi.on("session_shutdown", async () => {
		clearAllTimers();
	});
}
