import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getPresetCompletions, loadPresets, presetFileExists } from "./presets.ts";
import { formatClock, formatKoreanDuration, parseInterval } from "./time.ts";

export { formatClock, formatKoreanDuration, parseInterval } from "./time.ts";

const CUSTOM_TYPE = "until";
const PROMPT_MESSAGE_TYPE = "until-prompt";
const STATUS_KEY = "until-footer";

const MAX_TASKS = 3;
const MIN_INTERVAL_MS = 60_000;
const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000;
const JITTER_RATIO = 0.1;

interface ActiveRun {
	runCount: number;
	dispatchedAt: number;
}

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
	activeRun?: ActiveRun;
	lastSummary?: string;
	timer: ReturnType<typeof setTimeout>;
}

interface UntilPromptMessageDetails {
	taskId: number;
	runCount: number;
	intervalLabel: string;
	elapsed: string;
	displayPrompt: string;
	dispatchedAt: number;
}

interface UntilReportDetails {
	done: boolean;
	summary: string;
	taskId: number;
	runCount: number;
	nextRunAt?: number;
}

interface UntilExtensionOptions {
	presetsDir?: string;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function logTimerError(scope: string, error: unknown): void {
	try {
		process.stderr.write(`[until] ${scope}: ${formatError(error)}\n`);
	} catch {
		// stderr failures must not escape a timer callback.
	}
}

export function createUntilExtension(options: UntilExtensionOptions = {}) {
	const presetsDir = options.presetsDir ?? join(getAgentDir(), "until-presets");

	return function untilExtension(pi: ExtensionAPI) {
		const tasks = new Map<number, UntilTask>();
		let nextTaskId = 1;
		let agentRunning = false;
		let latestCtx: ExtensionContext | undefined;

		const safeNotify = (
			ctx: ExtensionContext | undefined,
			message: string,
			level: "info" | "warning" | "error",
		): void => {
			if (!ctx?.hasUI) return;
			try {
				ctx.ui.notify(message, level);
			} catch {
				// UI feedback is best-effort.
			}
		};

		const safeSendMessage = (
			message: Parameters<ExtensionAPI["sendMessage"]>[0],
			options?: Parameters<ExtensionAPI["sendMessage"]>[1],
		): boolean => {
			try {
				pi.sendMessage(message, options);
				return true;
			} catch {
				return false;
			}
		};

		const updateFooter = (): void => {
			const ctx = latestCtx;
			if (!ctx?.hasUI) return;

			try {
				if (tasks.size === 0) {
					ctx.ui.setStatus(STATUS_KEY, undefined);
					return;
				}

				let nearestRun = Number.POSITIVE_INFINITY;
				for (const task of tasks.values()) nearestRun = Math.min(nearestRun, task.nextRunAt);
				const nextLabel = nearestRun < Number.POSITIVE_INFINITY ? formatClock(nearestRun) : "-";
				const theme = ctx.ui.theme as unknown as {
					fg?: (color: string, text: string) => string;
				};
				const paint = (color: string, text: string) => (typeof theme?.fg === "function" ? theme.fg(color, text) : text);
				ctx.ui.setStatus(STATUS_KEY, paint("accent", `⏳ until ×${tasks.size}`) + paint("dim", ` | next ${nextLabel}`));
			} catch {
				// Footer failures must not affect task state or timers.
			}
		};

		const clearAllTasks = (): void => {
			for (const task of tasks.values()) clearTimeout(task.timer);
			tasks.clear();
			updateFooter();
		};

		const removeTask = (id: number): UntilTask | undefined => {
			const task = tasks.get(id);
			if (!task) return undefined;
			clearTimeout(task.timer);
			tasks.delete(id);
			updateFooter();
			return task;
		};

		const jitter = (ms: number): number => {
			const offset = ms * JITTER_RATIO * (Math.random() * 2 - 1);
			return Math.max(MIN_INTERVAL_MS, Math.round(ms + offset));
		};

		const contextIsIdle = (): boolean => {
			try {
				return latestCtx?.isIdle() === true;
			} catch {
				return false;
			}
		};

		let executeRun: (id: number) => void;

		const scheduleNext = (id: number): void => {
			const task = tasks.get(id);
			if (!task) return;

			clearTimeout(task.timer);
			const delay = jitter(task.intervalMs);
			task.nextRunAt = Date.now() + delay;
			task.timer = setTimeout(() => {
				try {
					executeRun(id);
				} catch (error) {
					logTimerError(`#${id} recurring timer failed`, error);
				}
			}, delay);
			updateFooter();
		};

		executeRun = (id: number): void => {
			const task = tasks.get(id);
			if (!task) return;

			const now = Date.now();
			if (now >= task.expiresAt) {
				const expired = removeTask(id);
				if (!expired) return;
				safeNotify(latestCtx, `⏳ until #${expired.id} 만료됨 (24시간 초과)`, "warning");
				safeSendMessage({
					customType: CUSTOM_TYPE,
					content: `[until #${expired.id}] 24시간 만료로 자동 종료됨\n마지막 상태: ${expired.lastSummary ?? "없음"}`,
					display: true,
				});
				return;
			}

			if (task.activeRun) {
				if (contextIsIdle()) task.activeRun = undefined;
				else {
					scheduleNext(id);
					return;
				}
			}

			task.runCount += 1;
			const activeRun: ActiveRun = { runCount: task.runCount, dispatchedAt: now };
			task.activeRun = activeRun;

			const elapsed = formatKoreanDuration(now - task.createdAt);
			const wrappedPrompt = [
				`[until #${task.id} - 실행 ${activeRun.runCount}회차, 경과 ${elapsed}, 간격 ${task.intervalLabel}]`,
				"",
				task.prompt,
				"",
				"작업을 수행한 뒤, 반드시 until_report 도구를 호출하여 결과를 보고하세요.",
				`- taskId: ${task.id} (이 값을 그대로 전달)`,
				`- runCount: ${activeRun.runCount} (이 값을 그대로 전달)`,
				"- done: true (조건 충족, 반복 종료) 또는 done: false (미충족, 계속 반복)",
				"- summary: 현재 상태를 한 줄로 요약",
			].join("\n");

			safeNotify(latestCtx, `⏳ until #${task.id} 실행 ${activeRun.runCount}회차`, "info");
			const sent = safeSendMessage(
				{
					customType: PROMPT_MESSAGE_TYPE,
					content: wrappedPrompt,
					display: true,
					details: {
						taskId: task.id,
						runCount: activeRun.runCount,
						intervalLabel: task.intervalLabel,
						elapsed,
						displayPrompt: task.displayPrompt,
						dispatchedAt: activeRun.dispatchedAt,
					} satisfies UntilPromptMessageDetails,
				},
				agentRunning ? { deliverAs: "followUp", triggerTurn: true } : { triggerTurn: true },
			);
			if (!sent && task.activeRun?.runCount === activeRun.runCount) {
				task.activeRun = undefined;
				logTimerError(`#${id} run ${activeRun.runCount} prompt dispatch failed`, "synchronous sendMessage error");
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
				safeNotify(ctx, `최대 ${MAX_TASKS}개까지만 등록할 수 있어. /until-cancel로 정리해줘.`, "error");
				return false;
			}
			if (intervalMs < MIN_INTERVAL_MS) {
				safeNotify(ctx, `최소 간격은 1분이야. ${formatKoreanDuration(intervalMs)}은 너무 짧아.`, "error");
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
				timer: setTimeout(() => {
					try {
						executeRun(id);
					} catch (error) {
						logTimerError(`#${id} initial timer failed`, error);
					}
				}, 0),
			};
			tasks.set(id, task);

			safeSendMessage({
				customType: CUSTOM_TYPE,
				content: `[until #${id}] 등록됨: ${intervalLabel}마다 반복\n만료: ${formatClock(task.expiresAt)}\nTask: ${displayPrompt}`,
				display: true,
				details: { id, prompt, displayPrompt, intervalMs, intervalLabel },
			});
			safeNotify(ctx, `⏳ until #${id} 등록됨 (${intervalLabel}마다)`, "info");
			updateFooter();
			return true;
		};

		pi.registerTool({
			name: "until_report",
			label: "Until Report",
			description: "until 반복 작업의 결과를 보고합니다. taskId와 runCount가 현재 회차와 일치해야 합니다.",
			promptSnippet: "Report until-loop result with taskId, runCount, done, and summary.",
			promptGuidelines: [
				"until 반복 작업 프롬프트를 받으면 작업 후 until_report에 프롬프트의 taskId와 runCount를 그대로 전달하세요.",
			],
			parameters: Type.Object({
				taskId: Type.Number({ description: "until task ID (프롬프트의 #N)" }),
				runCount: Type.Number({ description: "현재 until 실행 회차 (프롬프트의 runCount)" }),
				done: Type.Boolean({ description: "조건이 충족되었으면 true, 아니면 false" }),
				summary: Type.String({ description: "현재 상태를 한 줄로 요약" }),
			}),
			async execute(_toolCallId, params) {
				const task = tasks.get(params.taskId);
				if (!task) {
					throw new Error(`until #${params.taskId} 작업을 찾을 수 없습니다. 이미 완료/취소/만료되었을 수 있습니다.`);
				}
				if (!task.activeRun) {
					throw new Error(
						`until #${params.taskId}에 보고할 활성 회차가 없습니다. 이미 보고되었거나 정리된 회차입니다.`,
					);
				}
				if (params.runCount !== task.activeRun.runCount) {
					throw new Error(
						`until #${params.taskId} runCount ${params.runCount}는 현재 회차가 아닙니다. 현재 runCount는 ${task.activeRun.runCount}입니다.`,
					);
				}

				const reportedRunCount = task.activeRun.runCount;
				task.activeRun = undefined;
				task.lastSummary = params.summary;

				if (params.done) {
					const elapsed = formatKoreanDuration(Date.now() - task.createdAt);
					const completed = removeTask(task.id) ?? task;
					safeSendMessage({
						customType: CUSTOM_TYPE,
						content: `[until #${completed.id}] ✅ 조건 충족! (${reportedRunCount}회 실행, ${elapsed} 경과)\n결과: ${params.summary}`,
						display: true,
					});
					safeNotify(latestCtx, `✅ until #${completed.id} 완료: ${params.summary}`, "info");
					const details: UntilReportDetails = {
						done: true,
						summary: params.summary,
						taskId: completed.id,
						runCount: reportedRunCount,
					};
					return {
						content: [
							{ type: "text" as const, text: `until #${completed.id} 조건 충족으로 종료됨. ${params.summary}` },
						],
						details,
						terminate: true,
					};
				}

				const details: UntilReportDetails = {
					done: false,
					summary: params.summary,
					taskId: task.id,
					nextRunAt: task.nextRunAt,
					runCount: reportedRunCount,
				};
				return {
					content: [
						{
							type: "text" as const,
							text: `until #${task.id} 계속 반복. 다음 실행: ${formatClock(task.nextRunAt)}. ${params.summary}`,
						},
					],
					details,
				};
			},
		});

		pi.registerCommand("until", {
			description: "조건 충족까지 주기적 실행: /until <간격> <프롬프트> 또는 /until [간격] <프리셋>",
			getArgumentCompletions: (prefix) => {
				const trimmed = prefix.trimStart();
				if (!trimmed.includes(" ")) return getPresetCompletions(presetsDir, trimmed);
				const spaceIndex = trimmed.indexOf(" ");
				const firstToken = trimmed.slice(0, spaceIndex);
				const rest = trimmed.slice(spaceIndex + 1).trimStart();
				if (!parseInterval(firstToken) || rest.includes(" ")) return null;
				return getPresetCompletions(presetsDir, rest);
			},
			handler: async (args, ctx) => {
				latestCtx = ctx;
				const raw = (args ?? "").trim();
				const presets = await loadPresets(presetsDir);

				if (!raw) {
					const presetList = Object.values(presets)
						.map((preset) => `  ${preset.name} - ${preset.description} (기본 ${preset.defaultInterval.label})`)
						.join("\n");
					const help = presetList ? `\n\n프리셋:\n${presetList}\n예: /until PR 또는 /until 10m PR` : "";
					safeNotify(ctx, `사용법: /until <간격> <프롬프트>\n예: /until 5m PR 코멘트 확인해줘${help}`, "warning");
					return;
				}

				const directName = raw.toUpperCase();
				const directPreset = presets[directName];
				if (directPreset) {
					registerTask(
						directPreset.defaultInterval.ms,
						directPreset.defaultInterval.label,
						directPreset.prompt,
						ctx,
						`[preset ${directName}] ${directPreset.description}`,
					);
					return;
				}
				if (!directName.includes(" ") && presetFileExists(presetsDir, directName)) {
					safeNotify(
						ctx,
						`프리셋 "${directName}" 파일은 있지만 로드에 실패했어.\nfrontmatter(interval/description)와 본문을 확인해줘.`,
						"error",
					);
					return;
				}

				const spaceIndex = raw.indexOf(" ");
				if (spaceIndex === -1) {
					safeNotify(ctx, "프롬프트가 필요해. 예: /until 5m PR 코멘트 확인해줘\n프리셋: /until PR", "error");
					return;
				}

				const firstToken = raw.slice(0, spaceIndex);
				const rest = raw.slice(spaceIndex + 1).trim();
				const parsed = parseInterval(firstToken);
				if (!parsed) {
					safeNotify(
						ctx,
						`인터벌 "${firstToken}"을 파싱할 수 없어.\n지원 형식: 5m, 1h, 5분, 1시간, 5분마다, 1시간마다`,
						"error",
					);
					return;
				}
				if (!rest) {
					safeNotify(ctx, "프롬프트가 필요해. 예: /until 5m PR 코멘트 확인해줘", "error");
					return;
				}

				const presetName = rest.toUpperCase();
				const preset = presets[presetName];
				if (preset) {
					registerTask(parsed.ms, parsed.label, preset.prompt, ctx, `[preset ${presetName}] ${preset.description}`);
					return;
				}
				if (!presetName.includes(" ") && presetFileExists(presetsDir, presetName)) {
					safeNotify(
						ctx,
						`프리셋 "${presetName}" 파일은 있지만 로드에 실패했어.\nfrontmatter(interval/description)와 본문을 확인해줘.`,
						"error",
					);
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
					safeNotify(ctx, "활성 until 작업이 없어.", "info");
					return;
				}

				const now = Date.now();
				const lines = [...tasks.values()]
					.sort((left, right) => left.nextRunAt - right.nextRunAt)
					.map((task) => {
						const remain = formatKoreanDuration(Math.max(0, task.nextRunAt - now));
						const elapsed = formatKoreanDuration(now - task.createdAt);
						const summary = task.lastSummary ? `\n     최근: ${task.lastSummary}` : "";
						return `  #${task.id} · ${task.intervalLabel}마다 · 실행 ${task.runCount}회 · 경과 ${elapsed} · 다음 ${remain} 후${summary}\n     ${task.displayPrompt}`;
					});
				safeSendMessage({
					customType: CUSTOM_TYPE,
					content: `활성 until 목록 (${tasks.size}개)\n\n${lines.join("\n\n")}`,
					display: true,
				});
			},
		});

		pi.registerCommand("until-cancel", {
			description: "until 취소. 사용법: /until-cancel <id|all>",
			getArgumentCompletions: (prefix) => {
				const items = ["all", ...tasks.keys()].map(String).filter((value) => value.startsWith(prefix));
				return items.length > 0 ? items.map((value) => ({ value, label: value })) : null;
			},
			handler: async (args, ctx) => {
				latestCtx = ctx;
				const raw = (args ?? "").trim().toLowerCase();
				if (!raw) {
					safeNotify(ctx, "사용법: /until-cancel <id|all>", "info");
					return;
				}
				if (raw === "all") {
					const count = tasks.size;
					clearAllTasks();
					safeNotify(ctx, `until ${count}개 취소됨`, "info");
					return;
				}

				const id = Number(raw);
				if (!Number.isInteger(id)) {
					safeNotify(ctx, "id는 숫자여야 해. 예: /until-cancel 3", "warning");
					return;
				}
				if (!removeTask(id)) {
					safeNotify(ctx, `until #${id} 없음`, "warning");
					return;
				}
				safeNotify(ctx, `until #${id} 취소됨`, "info");
			},
		});

		pi.registerMessageRenderer<UntilPromptMessageDetails>(PROMPT_MESSAGE_TYPE, (message, { expanded }, theme) => {
			const details = message.details;
			const header = theme.fg(
				"accent",
				`[until #${details?.taskId ?? "?"} - 실행 ${details?.runCount ?? "?"}회차, 경과 ${details?.elapsed ?? "?"}, 간격 ${details?.intervalLabel ?? "?"}]`,
			);
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(header, 0, 0));
			box.addChild(new Spacer(1));

			if (!expanded) {
				box.addChild(new Text(theme.fg("customMessageText", `Task: ${details?.displayPrompt ?? "(unknown)"}`), 0, 0));
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

		pi.on("agent_settled", async (_event, ctx) => {
			agentRunning = false;
			latestCtx = ctx;
			let idle = false;
			try {
				idle = ctx.isIdle() === true;
			} catch {
				return;
			}
			if (!idle) return;
			for (const task of tasks.values()) task.activeRun = undefined;
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
			nextTaskId = 1;
			clearAllTasks();
		});

		pi.on("session_shutdown", async () => {
			agentRunning = false;
			clearAllTasks();
			latestCtx = undefined;
		});
	};
}

export default createUntilExtension();
