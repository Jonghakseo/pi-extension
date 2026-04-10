import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const CUSTOM_TYPE = "delayed-action";
const DEFAULT_SOON_DELAY_MS = 10 * 60 * 1000; // "좀 있다가" 기본값: 10분
const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000; // 7일

type ParsedReminder = {
	task: string;
	delayMs: number;
	delayLabel: string;
};

type Reminder = {
	id: number;
	task: string;
	delayMs: number;
	delayLabel: string;
	createdAt: number;
	dueAt: number;
	timer: ReturnType<typeof setTimeout>;
};

const EXPLICIT_DELAY_RE = /^(\d+)\s*(초|분|시간)\s*(?:있다가|후(?:에)?|뒤(?:에)?)\s*[,，:]?\s*(.+)$/i;
const SOON_DELAY_RE = /^(?:좀|조금|잠깐|잠시)\s*(?:있다가|후(?:에)?|뒤(?:에)?)\s*[,，:]?\s*(.+)$/i;
const DELAY_ONLY_RE = /^(?:\d+\s*(?:초|분|시간)|(?:좀|조금|잠깐|잠시))\s*(?:있다가|후(?:에)?|뒤(?:에)?)\s*$/i;

function toDelayMs(amount: number, unit: "초" | "분" | "시간"): number {
	if (unit === "초") return amount * 1000;
	if (unit === "시간") return amount * 60 * 60 * 1000;
	return amount * 60 * 1000;
}

function formatDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}초`;
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}분`;

	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (minutes === 0) return `${hours}시간`;
	return `${hours}시간 ${minutes}분`;
}

function formatClock(ts: number): string {
	return new Date(ts).toLocaleTimeString("ko-KR", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function parseReminderRequest(text: string): ParsedReminder | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const explicit = trimmed.match(EXPLICIT_DELAY_RE);
	if (explicit) {
		const amount = Number(explicit[1]);
		const unit = explicit[2] as "초" | "분" | "시간";
		const task = explicit[3]?.trim() ?? "";
		if (!Number.isFinite(amount) || amount <= 0 || !task) return null;

		const delayMs = toDelayMs(amount, unit);
		if (delayMs > MAX_DELAY_MS) return null;

		return {
			task,
			delayMs,
			delayLabel: `${amount}${unit}`,
		};
	}

	const soon = trimmed.match(SOON_DELAY_RE);
	if (soon) {
		const task = soon[1]?.trim() ?? "";
		if (!task) return null;
		return {
			task,
			delayMs: DEFAULT_SOON_DELAY_MS,
			delayLabel: formatDuration(DEFAULT_SOON_DELAY_MS),
		};
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	const reminders = new Map<number, Reminder>();
	let nextReminderId = 1;
	let agentRunning = false;
	let latestCtx: ExtensionContext | undefined;

	const clearAllReminders = () => {
		for (const reminder of reminders.values()) {
			clearTimeout(reminder.timer);
		}
		reminders.clear();
	};

	const listReminderLines = (): string[] => {
		const now = Date.now();
		return Array.from(reminders.values())
			.sort((a, b) => a.dueAt - b.dueAt)
			.map((r) => {
				const remainMs = Math.max(0, r.dueAt - now);
				return `#${r.id} · ${formatDuration(remainMs)} 후 · ${r.task}`;
			});
	};

	const fireReminder = (id: number) => {
		const reminder = reminders.get(id);
		if (!reminder) return;

		reminders.delete(id);

		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: `[reminder#${reminder.id}] 시간 도달 (${formatClock(Date.now())})\nTask: ${reminder.task}`,
			display: true,
			details: {
				id: reminder.id,
				task: reminder.task,
				dueAt: reminder.dueAt,
				createdAt: reminder.createdAt,
			},
		});

		const prompt = `예약한 시간이 되었어. 지금 아래 작업을 수행해줘.\n\n${reminder.task}`;
		if (agentRunning) {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} else {
			pi.sendUserMessage(prompt);
		}

		if (latestCtx?.hasUI) {
			latestCtx.ui.notify(`⏰ reminder #${reminder.id} 실행됨`, "info");
		}
	};

	const scheduleReminder = (parsed: ParsedReminder, ctx: ExtensionContext) => {
		const id = nextReminderId++;
		const createdAt = Date.now();
		const dueAt = createdAt + parsed.delayMs;

		const timer = setTimeout(() => fireReminder(id), parsed.delayMs);
		const reminder: Reminder = {
			id,
			task: parsed.task,
			delayMs: parsed.delayMs,
			delayLabel: parsed.delayLabel,
			createdAt,
			dueAt,
			timer,
		};
		reminders.set(id, reminder);

		pi.sendMessage({
			customType: CUSTOM_TYPE,
			content: `[reminder#${id}] 예약됨: ${parsed.delayLabel} 후\nTask: ${parsed.task}\nETA: ${formatClock(dueAt)}`,
			display: true,
			details: {
				id,
				task: parsed.task,
				delayMs: parsed.delayMs,
				dueAt,
				createdAt,
			},
		});

		if (ctx.hasUI) {
			ctx.ui.notify(`⏰ reminder #${id} 설정됨 (${parsed.delayLabel})`, "info");
		}
	};

	pi.registerCommand("reminders", {
		description: "List pending reminders",
		handler: async (_args, ctx) => {
			latestCtx = ctx;
			if (reminders.size === 0) {
				ctx.ui.notify("현재 예약된 reminder가 없어.", "info");
				return;
			}

			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: `Pending reminders\n\n${listReminderLines().join("\n")}`,
				display: true,
			});
		},
	});

	pi.registerCommand("reminder-cancel", {
		description: "Cancel reminder by id or all (usage: /reminder-cancel <id|all>)",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const raw = (args ?? "").trim().toLowerCase();
			if (!raw) {
				ctx.ui.notify("Usage: /reminder-cancel <id|all>", "info");
				return;
			}

			if (raw === "all") {
				const count = reminders.size;
				clearAllReminders();
				ctx.ui.notify(`reminder ${count}개 취소됨`, "info");
				return;
			}

			const id = Number(raw);
			if (!Number.isInteger(id)) {
				ctx.ui.notify("id는 숫자여야 해. 예: /reminder-cancel 3", "warning");
				return;
			}

			const target = reminders.get(id);
			if (!target) {
				ctx.ui.notify(`reminder #${id} 없음`, "warning");
				return;
			}

			clearTimeout(target.timer);
			reminders.delete(id);
			ctx.ui.notify(`reminder #${id} 취소됨`, "info");
		},
	});

	pi.on("input", async (event, ctx) => {
		latestCtx = ctx;
		if (event.source === "extension") return { action: "continue" as const };

		const text = event.text ?? "";
		if (DELAY_ONLY_RE.test(text.trim())) {
			if (ctx.hasUI) {
				ctx.ui.notify('예약할 작업도 같이 써줘. 예: "10분 있다가 배포 로그 확인해"', "warning");
			}
			return { action: "handled" as const };
		}

		const parsed = parseReminderRequest(text);
		if (!parsed) return { action: "continue" as const };

		scheduleReminder(parsed, ctx);
		return { action: "handled" as const };
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		latestCtx = ctx;
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
	});

	// Filter out delayed-action log messages before LLM sees them.
	// CustomMessageEntry (created by sendMessage) has role="custom" and participates
	// in LLM context by default. We strip them here so they remain visible in the TUI
	// (display:true is handled by the UI layer independently) but never reach the model.
	pi.on("context", async (event, _ctx) => {
		const filtered = event.messages.filter(
			(m) => !(m.role === "custom" && (m as { customType?: string }).customType === CUSTOM_TYPE),
		);
		if (filtered.length === event.messages.length) return;
		return { messages: filtered };
	});

	pi.on("session_start", async (_event, ctx) => {
		agentRunning = false;
		latestCtx = ctx;
		clearAllReminders();
	});

	pi.on("session_shutdown", async () => {
		agentRunning = false;
		clearAllReminders();
	});
}
