import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CRON_CLI_HELP_TEXT, parseCronToolCommand } from "./cli.ts";
import { getDaemonStatus, startDaemon, stopDaemon } from "./daemon-client.ts";
import { getLaunchdStatus, installLaunchAgent, uninstallLaunchAgent } from "./launchd.ts";
import { calculateNextRun, validateCron } from "./schedule.ts";
import {
	allocateJobId,
	findJob,
	loadJobs,
	readPromptFile,
	removeJob,
	updateJob,
	upsertJob,
	writePromptFile,
} from "./store.ts";
import type { CronJob, CronJobKind } from "./types.ts";

type CronAction =
	| "list"
	| "status"
	| "upsert"
	| "update"
	| "remove"
	| "enable"
	| "disable"
	| "run"
	| "start_daemon"
	| "stop_daemon"
	| "install_launchd"
	| "uninstall_launchd";

interface CronToolParams {
	action: CronAction;
	id?: string;
	name?: string;
	kind?: CronJobKind;
	schedule?: string;
	runAt?: string;
	promptMarkdown?: string;
	cwd?: string;
	enabled?: boolean;
	once?: boolean;
	includePrompt?: boolean;
	yes?: boolean;
}

interface CronToolResult {
	text: string;
	details?: Record<string, unknown>;
}

const CronParamsSchema = Type.Object({
	command: Type.String({
		description:
			"CLI-style cron command. Always start with 'cron help' to discover commands. Examples: 'cron status', 'cron list --include-prompt', 'cron upsert --name daily --kind cron --schedule \"0 10 * * *\" -- <self-contained promptMarkdown>', 'cron update daily --schedule \"30 9 * * 1-5\"', 'cron run daily', 'cron enable daily', 'cron disable daily', 'cron remove daily', 'cron install-launchd'. Scheduled prompts are headless, so promptMarkdown after `--` must include all required context.",
	}),
});

interface CronCliToolParams {
	command: string;
}

function localTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}

function formatJob(job: CronJob, includePrompt = false): string {
	const status = job.running
		? "🔄 running"
		: job.enabled
			? job.once
				? "✅ active · once"
				: "✅ active"
			: `⏸ disabled${job.disabledReason ? ` · ${job.disabledReason}` : ""}`;
	const schedule = job.kind === "cron" ? job.schedule : job.runAt;
	const lines = [
		`- **${job.id}** — ${job.name}`,
		`  status: ${status}`,
		`  kind: ${job.kind}${job.once ? " · once" : ""}`,
		`  schedule: ${schedule ?? "—"}`,
		`  nextRunAt: ${job.nextRunAt ?? "—"}`,
		`  lastRunAt: ${job.lastRunAt ?? "—"}`,
		`  cwd: ${job.cwd}`,
		`  promptFile: ${job.promptFile}`,
	];
	if (job.lastRunLog) lines.push(`  lastRunLog: ${job.lastRunLog}`);
	if (includePrompt) {
		const prompt = readPromptFile(job.id);
		if (prompt) {
			lines.push(
				"",
				"  prompt:",
				prompt
					.split("\n")
					.map((line) => `    ${line}`)
					.join("\n"),
			);
		}
	}
	return lines.join("\n");
}

function formatJobList(includePrompt = false): string {
	const jobs = loadJobs();
	if (jobs.length === 0) return "No cron jobs configured.";
	return [`Cron jobs (${jobs.length})`, "", ...jobs.map((job) => formatJob(job, includePrompt))].join("\n");
}

function formatStatus(): string {
	const daemon = getDaemonStatus();
	const launchd = getLaunchdStatus();
	const jobs = loadJobs();
	const active = jobs.filter((job) => job.enabled).length;
	return [
		`Daemon: ${daemon.running ? `✅ running (PID ${daemon.pid})` : "⏸ not running"}`,
		daemon.stalePid ? `Stale PID: ${daemon.stalePid}` : undefined,
		`LaunchAgent: ${launchd.installed ? "✅ installed" : "⏸ not installed"} · ${launchd.loaded ? "loaded" : "not loaded"}`,
		`LaunchAgent plist: ${launchd.plistPath}`,
		`Jobs: ${jobs.length} total · ${active} active`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function validateJobInput(kind: CronJobKind, schedule?: string, runAt?: string): void {
	if (kind === "cron") {
		if (!schedule) throw new Error("cron job requires schedule");
		const error = validateCron(schedule);
		if (error) throw new Error(`Invalid cron expression: ${error}`);
		return;
	}

	if (!runAt) throw new Error(`${kind} job requires runAt`);
	const date = new Date(runAt);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid runAt timestamp: ${runAt}`);
}

function ensureLaunchdAndDaemon(): string[] {
	const messages: string[] = [];
	const launchd = getLaunchdStatus();
	if (!launchd.installed || !launchd.loaded) messages.push(installLaunchAgent().message);
	messages.push(startDaemon().message);
	return messages;
}

function upsertFromParams(params: CronToolParams, ctx: ExtensionContext): { job: CronJob; messages: string[] } {
	const existing = params.id ? findJob(params.id) : undefined;
	const name = params.name ?? existing?.name;
	if (!name) throw new Error("name is required for upsert");

	const kind = params.kind ?? existing?.kind ?? "cron";
	const schedule = params.schedule ?? existing?.schedule;
	const runAt = params.runAt ?? existing?.runAt;
	validateJobInput(kind, schedule, runAt);

	const id = existing?.id ?? allocateJobId(name, params.id);
	const promptMarkdown = params.promptMarkdown;
	if (!promptMarkdown && !existing) throw new Error("promptMarkdown is required for new cron jobs");
	const promptFile = promptMarkdown ? writePromptFile(id, promptMarkdown) : existing?.promptFile;
	if (!promptFile) throw new Error("promptFile could not be resolved");

	const now = new Date().toISOString();
	const once = kind !== "cron" ? true : (params.once ?? existing?.once ?? false);
	const enabled = params.enabled ?? existing?.enabled ?? true;
	const baseJob: CronJob = {
		id,
		name,
		enabled,
		kind,
		once,
		schedule: kind === "cron" ? schedule : undefined,
		runAt: kind === "cron" ? undefined : new Date(runAt as string).toISOString(),
		timezone: existing?.timezone ?? localTimezone(),
		cwd: params.cwd ?? existing?.cwd ?? ctx.cwd,
		promptFile,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		lastRunAt: existing?.lastRunAt,
		running: existing?.running ?? false,
		lastExitCode: existing?.lastExitCode,
		lastRunLog: existing?.lastRunLog,
		disabledReason: enabled ? undefined : existing?.disabledReason,
		completedAt: enabled ? undefined : existing?.completedAt,
	};
	const job = { ...baseJob, nextRunAt: calculateNextRun(baseJob, new Date()) };
	upsertJob(job);
	return { job, messages: ensureLaunchdAndDaemon() };
}

async function confirmDangerous(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(title, message);
}

function requireId(params: CronToolParams, action: string): string {
	if (!params.id) throw new Error(`id is required for ${action}`);
	return params.id;
}

const toolHandlers: Record<
	CronAction,
	(params: CronToolParams, ctx: ExtensionContext) => Promise<CronToolResult> | CronToolResult
> = {
	list: (params) => ({ text: formatJobList(Boolean(params.includePrompt)), details: { jobs: loadJobs() } }),
	status: () => ({
		text: formatStatus(),
		details: { daemon: getDaemonStatus(), launchd: getLaunchdStatus(), jobs: loadJobs() },
	}),
	upsert: (params, ctx) => {
		const { job, messages } = upsertFromParams(params, ctx);
		return {
			text: [`✓ Upserted cron job "${job.id}"`, "", formatJob(job), "", ...messages].join("\n"),
			details: { job, messages },
		};
	},
	update: (params, ctx) => {
		const id = requireId(params, "update");
		const existing = findJob(id);
		if (!existing) throw new Error(`Cron job not found: ${id}`);
		const { job, messages } = upsertFromParams(
			{ ...params, action: "upsert", name: params.name ?? existing.name },
			ctx,
		);
		return {
			text: [`✓ Updated cron job "${job.id}"`, "", formatJob(job), "", ...messages].join("\n"),
			details: { job, messages },
		};
	},
	remove: async (params, ctx) => {
		const id = requireId(params, "remove");
		const job = findJob(id);
		if (!job) return { text: `Cron job not found: ${id}` };
		const ok = await confirmDangerous(ctx, "Cron job 삭제", `"${job.id}" (${job.name}) 크론잡을 삭제할까요?`);
		if (!ok) return { text: `Deletion cancelled for cron job "${job.id}".` };
		removeJob(job.id);
		return { text: `✓ Removed cron job "${job.id}".`, details: { removed: job } };
	},
	enable: (params) => {
		const id = requireId(params, "enable");
		const job = updateJob(id, (current) => {
			const enabled = { ...current, enabled: true, disabledReason: undefined, completedAt: undefined };
			return { ...enabled, nextRunAt: calculateNextRun(enabled, new Date()) };
		});
		if (!job) throw new Error(`Cron job not found: ${id}`);
		return { text: `✓ Enabled cron job "${job.id}". Next run: ${job.nextRunAt ?? "—"}`, details: { job } };
	},
	disable: (params) => {
		const id = requireId(params, "disable");
		const job = updateJob(id, (current) => ({
			...current,
			enabled: false,
			nextRunAt: undefined,
			disabledReason: "user_disabled",
		}));
		if (!job) throw new Error(`Cron job not found: ${id}`);
		return { text: `✓ Disabled cron job "${job.id}".`, details: { job } };
	},
	run: (params) => {
		const id = requireId(params, "run");
		const job = updateJob(id, (current) => ({
			...current,
			enabled: true,
			nextRunAt: new Date().toISOString(),
			disabledReason: undefined,
		}));
		if (!job) throw new Error(`Cron job not found: ${id}`);
		const daemon = startDaemon();
		return { text: `✓ Queued cron job "${job.id}" for immediate run. ${daemon.message}`, details: { job, daemon } };
	},
	start_daemon: () => {
		const result = startDaemon();
		return { text: result.message, details: { result } };
	},
	stop_daemon: () => {
		const result = stopDaemon();
		return { text: result.message, details: { result } };
	},
	install_launchd: () => {
		const result = installLaunchAgent();
		return { text: result.message, details: { result, launchd: getLaunchdStatus() } };
	},
	uninstall_launchd: async (params, ctx) => {
		if (!params.yes) {
			const ok = await confirmDangerous(ctx, "Cron launchd 해제", "재부팅 후 cron daemon 자동 실행 등록을 제거할까요?");
			if (!ok) return { text: "launchd uninstall cancelled." };
		}
		const result = uninstallLaunchAgent();
		return { text: result.message, details: { result, launchd: getLaunchdStatus() } };
	},
};

function notify(ctx: ExtensionCommandContext, message: string, kind: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, kind);
}

function updateJobForImmediateRun(id: string): CronJob | undefined {
	return updateJob(id, (current) => ({ ...current, enabled: true, nextRunAt: new Date().toISOString() }));
}

function enableJob(id: string): CronJob | undefined {
	return updateJob(id, (current) => {
		const enabled = { ...current, enabled: true, disabledReason: undefined, completedAt: undefined };
		return { ...enabled, nextRunAt: calculateNextRun(enabled, new Date()) };
	});
}

function disableJob(id: string): CronJob | undefined {
	return updateJob(id, (current) => ({
		...current,
		enabled: false,
		nextRunAt: undefined,
		disabledReason: "user_disabled",
	}));
}

const commandHandlers = {
	status: async (_id: string | undefined, ctx: ExtensionCommandContext) => notify(ctx, formatStatus()),
	install: async (_id: string | undefined, ctx: ExtensionCommandContext) => {
		const result = installLaunchAgent();
		notify(ctx, result.message, result.ok ? "info" : "error");
	},
	uninstall: async (id: string | undefined, ctx: ExtensionCommandContext) => {
		if (id !== "--yes") {
			const ok = await confirmDangerous(ctx, "Cron launchd 해제", "재부팅 후 cron daemon 자동 실행 등록을 제거할까요?");
			if (!ok) return notify(ctx, "launchd uninstall cancelled", "warning");
		}
		const result = uninstallLaunchAgent();
		notify(ctx, result.message, result.ok ? "info" : "error");
	},
	start: async (_id: string | undefined, ctx: ExtensionCommandContext) => {
		const result = startDaemon();
		notify(ctx, result.message, result.ok ? "info" : "error");
	},
	stop: async (_id: string | undefined, ctx: ExtensionCommandContext) => {
		const result = stopDaemon();
		notify(ctx, result.message, result.ok ? "info" : "error");
	},
	list: async (_id: string | undefined, ctx: ExtensionCommandContext, _pi: ExtensionAPI) => {
		notify(ctx, formatJobList());
	},
	run: async (id: string | undefined, ctx: ExtensionCommandContext) => {
		if (!id) return notify(ctx, "Usage: /cron run <id>", "warning");
		const job = updateJobForImmediateRun(id);
		if (!job) return notify(ctx, `Cron job not found: ${id}`, "error");
		notify(ctx, `Queued ${id}. ${startDaemon().message}`);
	},
	remove: async (id: string | undefined, ctx: ExtensionCommandContext) => {
		if (!id) return notify(ctx, "Usage: /cron remove <id>", "warning");
		const job = findJob(id);
		if (!job) return notify(ctx, `Cron job not found: ${id}`, "error");
		const ok = await confirmDangerous(ctx, "Cron job 삭제", `"${job.id}" (${job.name}) 크론잡을 삭제할까요?`);
		if (!ok) return notify(ctx, "Deletion cancelled", "warning");
		removeJob(job.id);
		notify(ctx, `Removed ${job.id}`);
	},
	enable: async (id: string | undefined, ctx: ExtensionCommandContext) => {
		if (!id) return notify(ctx, "Usage: /cron enable <id>", "warning");
		const job = enableJob(id);
		notify(ctx, job ? `Enabled ${job.id}` : `Cron job not found: ${id}`, job ? "info" : "error");
	},
	disable: async (id: string | undefined, ctx: ExtensionCommandContext) => {
		if (!id) return notify(ctx, "Usage: /cron disable <id>", "warning");
		const job = disableJob(id);
		notify(ctx, job ? `Disabled ${job.id}` : `Cron job not found: ${id}`, job ? "info" : "error");
	},
} satisfies Record<string, (id: string | undefined, ctx: ExtensionCommandContext, pi: ExtensionAPI) => Promise<void>>;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "cron",
		label: "Cron",
		description:
			'CLI-style interface for persistent scheduled pi jobs. Always start with `cron help` to learn available commands, then call via `{ command: "cron ..." }`. Jobs are stored as markdown prompts and run headlessly via a launchd-backed daemon; prompt markdown after `--` must be self-contained.',
		promptSnippet:
			"Schedule, list, update, run, enable/disable, or remove persistent cron jobs via `cron help` commands.",
		promptGuidelines: [
			"Use cron when the user asks to run something later, repeatedly, at a specific date/time, after a delay, or on a schedule.",
			"Always start with `cron help` if you need to learn the command grammar; the tool accepts only a single `command` string.",
			'For upsert/update with a prompt, put the self-contained promptMarkdown after `--`, e.g. `cron upsert --name daily --kind cron --schedule "0 10 * * *" -- <promptMarkdown>`.',
			"When the user says '방금 한 것', '이 작업', '아까 정리한 것', or otherwise references current session context, include all necessary context in the promptMarkdown because scheduled runs are headless and separate from this session history.",
			"Translate natural-language schedules into kind plus either a standard 5-field cron schedule or an ISO runAt timestamp. Use kind `at` or `delay` for one-shot jobs; for a cron expression that should run once, pass `--once`.",
			"`cron remove <id>` requires user confirmation. `cron uninstall-launchd --yes` explicitly confirms launchd uninstall without an extra UI dialog.",
		],
		parameters: CronParamsSchema,

		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const parsedCommand = parseCronToolCommand((rawParams as CronCliToolParams).command);
			if (parsedCommand.type === "error") {
				return {
					content: [{ type: "text" as const, text: `${parsedCommand.message}\n\n${CRON_CLI_HELP_TEXT}` }],
					details: {},
					isError: true,
				};
			}
			if (parsedCommand.type === "help") {
				return { content: [{ type: "text" as const, text: CRON_CLI_HELP_TEXT }], details: {} };
			}

			const params = parsedCommand.params as unknown as CronToolParams;
			const handler = toolHandlers[params.action];
			if (!handler) throw new Error(`Unknown cron action: ${params.action}`);
			const result = await handler(params, ctx);
			return { content: [{ type: "text" as const, text: result.text }], details: result.details ?? {} };
		},

		renderCall(args, theme) {
			const params = args as Partial<CronCliToolParams>;
			const raw = typeof params.command === "string" ? params.command.trim() : "";
			const command = raw || "cron help";
			const maxCallLines = 5;
			const commandLines = command.split("\n");
			const truncated = commandLines.length > maxCallLines;
			const preview = truncated ? commandLines.slice(0, maxCallLines).join("\n") : command;

			let text = theme.fg("toolTitle", theme.bold("cron ")) + theme.fg("accent", "cli");
			text += `\n  ${theme.fg("dim", preview)}`;
			if (truncated) text += `\n  ${theme.fg("muted", `... +${commandLines.length - maxCallLines} more lines`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const raw = result.content[0];
			const fullText = (raw?.type === "text" ? raw.text : undefined) ?? "(no output)";
			if (expanded) return new Text(fullText, 0, 0);

			const lines = fullText.split("\n");
			const firstLine = lines[0] ?? "";
			const suffix = lines.length > 1 ? theme.fg("muted", ` (+${lines.length - 1} lines)`) : "";
			return new Text(firstLine + suffix, 0, 0);
		},
	});

	pi.registerCommand("cron", {
		description: "Persistent cron daemon: /cron status|install|uninstall|start|stop|list|run|remove|enable|disable",
		getArgumentCompletions: (prefix) => {
			const tokens = prefix.trimStart().split(/\s+/);
			if (tokens.length <= 1) {
				return Object.keys(commandHandlers)
					.filter((value) => value.startsWith(tokens[0] ?? ""))
					.map((value) => ({ value, label: value }));
			}
			const command = tokens[0];
			if (!["run", "remove", "enable", "disable"].includes(command)) return null;
			const idPrefix = tokens[1] ?? "";
			return loadJobs()
				.filter((job) => job.id.startsWith(idPrefix))
				.map((job) => ({ value: job.id, label: `${job.id} — ${job.name}` }));
		},
		handler: async (args, ctx) => {
			const [rawCommand = "status", id] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const command = rawCommand || "status";
			const handler = commandHandlers[command as keyof typeof commandHandlers];
			if (!handler) return notify(ctx, `Unknown /cron command: ${command}`, "warning");
			await handler(id, ctx, pi);
		},
	});
}
