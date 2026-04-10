import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const CUSTOM_TYPE = "until";
const PROMPT_MESSAGE_TYPE = "until-prompt";
const STATUS_KEY = "until-footer";

const MAX_TASKS = 3;
const MIN_INTERVAL_MS = 60_000; // 1분
const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24시간
const JITTER_RATIO = 0.1; // ±10%

const INTERVAL_RE = /^(\d+(?:\.\d+)?)\s*(?:(m|h|분|시간)(?:마다)?)\s*$/i;

interface UntilTask {
	id: number;
	prompt: string;
	displayPrompt: string;
	intervalMs: number;
	intervalLabel: string;
	createdAt: number;
	expiresAt: number;
	nextRunAt: number;
	runCount: number;
	inFlight: boolean;
	lastSummary?: string;
	timer: ReturnType<typeof setTimeout>;
}

interface UntilPromptMessageDetails {
	taskId: number;
	runCount: number;
	intervalLabel: string;
	elapsed: string;
	displayPrompt: string;
}

interface UntilReportDetails {
	done: boolean;
	summary: string;
	taskId: number;
	runCount: number;
	nextRunAt?: number;
}

export function formatKoreanDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}초`;
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}분`;

	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (minutes === 0) return `${hours}시간`;
	return `${hours}시간 ${minutes}분`;
}

export function formatClock(ts: number): string {
	return new Date(ts).toLocaleTimeString("ko-KR", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

export function parseInterval(raw: string): { ms: number; label: string } | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	const match = trimmed.match(INTERVAL_RE);
	if (!match) return null;

	const amount = Number(match[1]);
	const unitRaw = match[2].toLowerCase();

	if (!Number.isFinite(amount) || amount <= 0) return null;

	switch (unitRaw) {
		case "m":
		case "분":
			return { ms: amount * 60 * 1000, label: `${amount}분` };
		case "h":
		case "시간":
			return { ms: amount * 60 * 60 * 1000, label: `${amount}시간` };
		default:
			return null;
	}
}

export default function (pi: ExtensionAPI) {
	const tasks = new Map<number, UntilTask>();
	let nextTaskId = 1;
	let agentRunning = false;
	let latestCtx: ExtensionContext | undefined;

	const notify = (ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error") => {
		if (!ctx?.hasUI) return;
		ctx.ui.notify(message, level);
	};

	const clearAllTasks = () => {
		for (const task of tasks.values()) clearTimeout(task.timer);
		tasks.clear();
		updateFooter();
	};

	const removeTask = (id: number) => {
		const task = tasks.get(id);
		if (!task) return;
		clearTimeout(task.timer);
		tasks.delete(id);
		updateFooter();
	};

	const updateFooter = () => {
		if (!latestCtx?.hasUI) return;
		const theme = latestCtx.ui.theme;

		if (tasks.size === 0) {
			latestCtx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		let nearestRun = Number.POSITIVE_INFINITY;
		for (const task of tasks.values()) {
			if (task.nextRunAt < nearestRun) nearestRun = task.nextRunAt;
		}

		const nextLabel = nearestRun < Number.POSITIVE_INFINITY ? formatClock(nearestRun) : "—";
		const text = theme.fg("accent", `⏳ until ×${tasks.size}`) + theme.fg("dim", ` | next ${nextLabel}`);
		latestCtx.ui.setStatus(STATUS_KEY, text);
	};

	const jitter = (ms: number): number => {
		const offset = ms * JITTER_RATIO * (Math.random() * 2 - 1);
		return Math.max(MIN_INTERVAL_MS, Math.round(ms + offset));
	};

	const scheduleNext = (id: number) => {
		const task = tasks.get(id);
		if (!task) return;

		clearTimeout(task.timer);

		const delay = jitter(task.intervalMs);
		task.nextRunAt = Date.now() + delay;
		task.timer = setTimeout(() => executeRun(id), delay);
		updateFooter();
	};

	const executeRun = (id: number) => {
		const task = tasks.get(id);
		if (!task) return;

		const now = Date.now();
		if (now >= task.expiresAt) {
			notify(latestCtx, `⏳ until #${task.id} 만료됨 (24시간 초과)`, "warning");
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: `[until #${task.id}] 24시간 만료로 자동 종료됨\n마지막 상태: ${task.lastSummary ?? "없음"}`,
				display: true,
			});
			removeTask(id);
			return;
		}

		if (task.inFlight) {
			scheduleNext(id);
			return;
		}

		task.runCount += 1;

		const elapsed = formatKoreanDuration(now - task.createdAt);
		const wrappedPrompt = [
			`[until #${task.id} — 실행 ${task.runCount}회차, 경과 ${elapsed}, 간격 ${task.intervalLabel}]`,
			"",
			task.prompt,
			"",
			"작업을 수행한 뒤, 반드시 until_report 도구를 호출하여 결과를 보고하세요.",
			`- taskId: ${task.id} (이 값을 그대로 전달)`,
			"- done: true (조건 충족, 반복 종료) 또는 done: false (미충족, 계속 반복)",
			"- summary: 현재 상태를 한 줄로 요약",
		].join("\n");

		notify(latestCtx, `⏳ until #${task.id} 실행 ${task.runCount}회차`, "info");
		task.inFlight = true;

		try {
			pi.sendMessage(
				{
					customType: PROMPT_MESSAGE_TYPE,
					content: wrappedPrompt,
					display: true,
					details: {
						taskId: task.id,
						runCount: task.runCount,
						intervalLabel: task.intervalLabel,
						elapsed,
						displayPrompt: task.displayPrompt,
					} satisfies UntilPromptMessageDetails,
				},
				agentRunning ? { deliverAs: "followUp", triggerTurn: true } : { triggerTurn: true },
			);
		} catch {
			task.inFlight = false;
		}

		scheduleNext(id);
	};

	const registerTask = (
		intervalMs: number,
		intervalLabel: string,
		prompt: string,
		ctx: ExtensionContext,
		displayPrompt = prompt,
	): boolean => {
		if (tasks.size >= MAX_TASKS) {
			notify(ctx, `최대 ${MAX_TASKS}개까지만 등록할 수 있어. /until-cancel로 정리해줘.`, "error");
			return false;
		}

		if (intervalMs < MIN_INTERVAL_MS) {
			notify(ctx, `최소 간격은 1분이야. ${formatKoreanDuration(intervalMs)}은 너무 짧아.`, "error");
			return false;
		}

		const id = nextTaskId++;
		const now = Date.now();
		const task: UntilTask = {
			id,
			prompt,
			displayPrompt,
			intervalMs,
			intervalLabel,
			createdAt: now,
			expiresAt: now + MAX_EXPIRY_MS,
			nextRunAt: now,
			runCount: 0,
			inFlight: false,
			timer: setTimeout(() => executeRun(id), 0),
		};

		tasks.set(id, task);
		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: `[until #${id}] 등록됨: ${intervalLabel}마다 반복\n만료: ${formatClock(task.expiresAt)}\nTask: ${displayPrompt}`,
			display: true,
			details: { id, prompt, displayPrompt, intervalMs, intervalLabel },
		});
		notify(ctx, `⏳ until #${id} 등록됨 (${intervalLabel}마다)`, "info");
		updateFooter();
		return true;
	};

	pi.registerTool({
		name: "until_report",
		label: "Until Report",
		description: "until 반복 작업의 결과를 보고합니다. 조건 충족 시 done: true로 반복을 종료합니다.",
		promptSnippet: "Report until-loop result: done (condition met?) + summary",
		promptGuidelines: ["until 반복 작업 프롬프트를 받으면, 작업 수행 후 반드시 until_report를 호출하세요."],
		parameters: Type.Object({
			taskId: Type.Number({
				description: "until task ID (프롬프트의 #N)",
			}),
			done: Type.Boolean({
				description: "조건이 충족되었으면 true, 아니면 false",
			}),
			summary: Type.String({
				description: "현재 상태를 한 줄로 요약",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const task = tasks.get(params.taskId);
			if (!task) {
				throw new Error(`until #${params.taskId} 작업을 찾을 수 없습니다. 이미 완료/취소/만료되었을 수 있습니다.`);
			}

			task.inFlight = false;
			task.lastSummary = params.summary;

			if (params.done) {
				const elapsed = formatKoreanDuration(Date.now() - task.createdAt);
				pi.sendMessage({
					customType: CUSTOM_TYPE,
					content: `[until #${task.id}] ✅ 조건 충족! (${task.runCount}회 실행, ${elapsed} 경과)\n결과: ${params.summary}`,
					display: true,
				});
				notify(latestCtx, `✅ until #${task.id} 완료: ${params.summary}`, "info");
				removeTask(task.id);

				return {
					content: [
						{
							type: "text" as const,
							text: `until #${task.id} 조건 충족으로 종료됨. ${params.summary}`,
						},
					],
					details: {
						done: true,
						summary: params.summary,
						taskId: task.id,
						runCount: task.runCount,
					} satisfies UntilReportDetails,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `until #${task.id} 계속 반복. 다음 실행: ${formatClock(task.nextRunAt)}. ${params.summary}`,
					},
				],
				details: {
					done: false,
					summary: params.summary,
					taskId: task.id,
					nextRunAt: task.nextRunAt,
					runCount: task.runCount,
				} satisfies UntilReportDetails,
			};
		},
	});

	pi.registerCommand("until", {
		description: "조건 충족까지 주기적 실행. 사용법: /until <간격> <프롬프트>",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const raw = (args ?? "").trim();
			if (!raw) {
				notify(ctx, "사용법: /until <간격> <프롬프트>\n예: /until 5m PR 코멘트 확인해줘", "warning");
				return;
			}

			const spaceIdx = raw.indexOf(" ");
			if (spaceIdx === -1) {
				notify(ctx, "프롬프트가 필요해. 예: /until 5m PR 코멘트 확인해줘", "error");
				return;
			}

			const firstToken = raw.slice(0, spaceIdx);
			const rest = raw.slice(spaceIdx + 1).trim();
			const parsed = parseInterval(firstToken);
			if (!parsed) {
				notify(
					ctx,
					`인터벌 "${firstToken}"을 파싱할 수 없어.\n지원 형식: 5m, 1h, 5분, 1시간, 5분마다, 1시간마다`,
					"error",
				);
				return;
			}

			if (!rest) {
				notify(ctx, "프롬프트가 필요해. 예: /until 5m PR 코멘트 확인해줘", "error");
				return;
			}

			registerTask(parsed.ms, parsed.label, rest, ctx);
		},
	});

	pi.registerCommand("untils", {
		description: "활성 until 목록 보기",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			if (tasks.size === 0) {
				notify(ctx, "활성 until 작업이 없어.", "info");
				return;
			}

			const now = Date.now();
			const lines = [...tasks.values()]
				.sort((a, b) => a.nextRunAt - b.nextRunAt)
				.map((task) => {
					const remain = formatKoreanDuration(Math.max(0, task.nextRunAt - now));
					const elapsed = formatKoreanDuration(now - task.createdAt);
					const summary = task.lastSummary ? `\n     최근: ${task.lastSummary}` : "";
					return `  #${task.id} · ${task.intervalLabel}마다 · 실행 ${task.runCount}회 · 경과 ${elapsed} · 다음 ${remain} 후${summary}\n     ${task.displayPrompt}`;
				});

			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: `활성 until 목록 (${tasks.size}개)\n\n${lines.join("\n\n")}`,
				display: true,
			});
		},
	});

	pi.registerCommand("until-cancel", {
		description: "until 취소. 사용법: /until-cancel <id|all>",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const raw = (args ?? "").trim().toLowerCase();
			if (!raw) {
				notify(ctx, "사용법: /until-cancel <id|all>", "info");
				return;
			}

			if (raw === "all") {
				const count = tasks.size;
				clearAllTasks();
				notify(ctx, `until ${count}개 취소됨`, "info");
				return;
			}

			const id = Number(raw);
			if (!Number.isInteger(id)) {
				notify(ctx, "id는 숫자여야 해. 예: /until-cancel 3", "warning");
				return;
			}

			const task = tasks.get(id);
			if (!task) {
				notify(ctx, `until #${id} 없음`, "warning");
				return;
			}

			removeTask(id);
			notify(ctx, `until #${id} 취소됨`, "info");
		},
	});

	pi.registerMessageRenderer<UntilPromptMessageDetails>(PROMPT_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details;
		const header = theme.fg(
			"accent",
			`[until #${details?.taskId ?? "?"} — 실행 ${details?.runCount ?? "?"}회차, 경과 ${details?.elapsed ?? "?"}, 간격 ${details?.intervalLabel ?? "?"}]`,
		);

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(header, 0, 0));
		box.addChild(new Spacer(1));

		if (!expanded) {
			const summary = details?.displayPrompt ? `Task: ${details.displayPrompt}` : "Task: (unknown)";
			box.addChild(new Text(theme.fg("customMessageText", summary), 0, 0));
			box.addChild(new Spacer(1));
			box.addChild(new Text(theme.fg("dim", "전체 프롬프트는 접혀 있음 · 확장해서 확인 가능"), 0, 0));
			return box;
		}

		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content) => content.type === "text")
						.map((content) => content.text)
						.join("\n");

		box.addChild(
			new Markdown(text, 0, 0, getMarkdownTheme(), {
				color: (value) => theme.fg("customMessageText", value),
			}),
		);
		return box;
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		latestCtx = ctx;
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
	});

	pi.on("context", async (event) => {
		const filtered = event.messages.filter(
			(message) => !(message.role === "custom" && (message as { customType?: string }).customType === CUSTOM_TYPE),
		);
		if (filtered.length === event.messages.length) return;
		return { messages: filtered };
	});

	pi.on("session_start", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		clearAllTasks();
	});

	pi.on("session_shutdown", async () => {
		agentRunning = false;
		clearAllTasks();
	});
}
