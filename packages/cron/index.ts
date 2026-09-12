import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CRON_CLI_HELP_TEXT, parseCronToolCommand } from "./cli.ts";
import { getDaemonStatus, scheduleDaemonUpgrade, startDaemon, stopDaemon } from "./daemon-client.ts";
import { getLaunchdStatus, installLaunchAgent, uninstallLaunchAgent } from "./launchd.ts";
import { resolveProjectId } from "./project-id.ts";
import { calculateNextRun, validateCron } from "./schedule.ts";
import {
	canonicalSessionFile,
	releaseDrainingSessionOwner,
	SessionBridge,
	validatePersistedSessionFile,
} from "./session-bridge.ts";
import {
	allocateJobIdFromStore,
	findJob,
	loadHistory,
	loadJobs,
	readPromptFile,
	withStoreTransaction,
	writePromptFile,
} from "./store.ts";
import type { CronJob, CronJobKind, CronScope } from "./types.ts";

type CronAction =
	| "list"
	| "history"
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
	scope?: CronScope;
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
			"CLI-style cron command. New jobs default to --scope user. Use --scope project for the current Git project or --scope session to deliver into this persisted Pi session. Examples: 'cron list --scope project', 'cron upsert --scope session --name follow-up --kind delay --run-at <iso> -- <promptMarkdown>'.",
	}),
});

function localTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}

function jobScope(job: CronJob): CronScope {
	return job.scope ?? "user";
}

interface ScopeContext {
	projectId: string;
	sessionId?: string;
	sessionFile?: string;
}

function scopeContext(ctx: ExtensionContext): ScopeContext {
	const sessionId = ctx.sessionManager.getSessionId();
	const file = ctx.sessionManager.getSessionFile();
	let sessionFile: string | undefined;
	try {
		sessionFile = file && sessionId ? validatePersistedSessionFile(sessionId, file) : undefined;
	} catch {
		sessionFile = undefined;
	}
	return {
		projectId: resolveProjectId(ctx.cwd).id,
		sessionId: sessionId || undefined,
		sessionFile,
	};
}

function ownerForScope(
	scope: CronScope,
	ctx: ExtensionContext,
): Pick<CronJob, "scope" | "projectId" | "sessionId" | "sessionFile"> {
	if (scope === "user") return { scope };
	if (scope === "project") return { scope, projectId: resolveProjectId(ctx.cwd).id };
	const current = scopeContext(ctx);
	if (!current.sessionId || !current.sessionFile) {
		throw new Error("session scope requires a persisted current Pi session");
	}
	return { scope, sessionId: current.sessionId, sessionFile: current.sessionFile };
}

function isAccessible(job: CronJob, ctx: ExtensionContext): boolean {
	const scope = jobScope(job);
	if (scope === "user") return true;
	const current = scopeContext(ctx);
	if (scope === "project") return job.projectId === current.projectId;
	if (!current.sessionId || !current.sessionFile || job.sessionId !== current.sessionId || !job.sessionFile)
		return false;
	try {
		return canonicalSessionFile(job.sessionFile) === current.sessionFile;
	} catch {
		return false;
	}
}

function visibleJobs(jobs: CronJob[], ctx: ExtensionContext, scope?: CronScope): CronJob[] {
	return jobs.filter((job) => isAccessible(job, ctx) && (!scope || jobScope(job) === scope));
}

function accessibleJob(id: string, ctx: ExtensionContext, scope?: CronScope): CronJob | undefined {
	const job = findJob(id);
	if (!job || !isAccessible(job, ctx) || (scope && jobScope(job) !== scope)) return undefined;
	return job;
}

function requireAccessibleJob(id: string, ctx: ExtensionContext, scope?: CronScope): CronJob {
	const job = accessibleJob(id, ctx, scope);
	if (!job) throw new Error(`Cron job not found in the current accessible scope: ${id}`);
	return job;
}

function updateAccessibleJob(
	id: string,
	ctx: ExtensionContext,
	scope: CronScope | undefined,
	update: (job: CronJob) => CronJob,
): CronJob {
	return withStoreTransaction((store) => {
		const index = store.jobs.findIndex((job) => job.id === id);
		const current = store.jobs[index];
		if (!current || !isAccessible(current, ctx) || (scope && jobScope(current) !== scope)) {
			throw new Error(`Cron job not found in the current accessible scope: ${id}`);
		}
		store.jobs[index] = { ...update(current), updatedAt: new Date().toISOString() };
		return store.jobs[index];
	});
}

function removeAccessibleJob(id: string, ctx: ExtensionContext, scope?: CronScope): CronJob | undefined {
	return withStoreTransaction((store) => {
		const index = store.jobs.findIndex((job) => job.id === id);
		const current = store.jobs[index];
		if (!current || !isAccessible(current, ctx) || (scope && jobScope(current) !== scope)) return undefined;
		store.jobs.splice(index, 1);
		return current;
	});
}

function formatJob(job: CronJob, includePrompt = false, historical = false): string {
	const status = historical
		? job.lastDeliveryOutcome
			? `📚 delivery ${job.lastDeliveryOutcome}`
			: `📚 archived attempt${job.lastExitCode === undefined ? "" : ` · exit ${job.lastExitCode}`}`
		: job.running
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
		`  scope: ${jobScope(job)}`,
		job.projectId ? `  projectId: ${job.projectId}` : undefined,
		job.sessionId ? `  sessionId: ${job.sessionId}` : undefined,
		job.sessionFile ? `  sessionFile: ${job.sessionFile}` : undefined,
		`  kind: ${job.kind}${job.once ? " · once" : ""}`,
		`  schedule: ${schedule ?? "—"}`,
		`  nextRunAt: ${job.nextRunAt ?? "—"}`,
		`  lastRunAt: ${job.lastRunAt ?? "—"}`,
		`  cwd: ${job.cwd}`,
		`  promptFile: ${job.promptFile}`,
	].filter((line): line is string => Boolean(line));
	if (job.lastRunLog) lines.push(`  lastRunLog: ${job.lastRunLog}`);
	if (job.lastDeliveryOutcome) lines.push(`  lastDeliveryOutcome: ${job.lastDeliveryOutcome}`);
	if (job.lastDeliveryError) lines.push(`  lastDeliveryError: ${job.lastDeliveryError}`);
	if (includePrompt) {
		let prompt = readPromptFile(job.id);
		if (historical && job.lastRunPromptFile) {
			try {
				prompt = readFileSync(job.lastRunPromptFile, "utf8");
			} catch {}
		}
		if (prompt) lines.push("", "  prompt:", ...prompt.split("\n").map((line) => `    ${line}`));
	}
	return lines.join("\n");
}

function formatJobList(ctx: ExtensionContext, scope?: CronScope, includePrompt = false): string {
	const jobs = visibleJobs(loadJobs(), ctx, scope);
	if (jobs.length === 0) return "No accessible current cron jobs configured.";
	return [`Current cron jobs (${jobs.length})`, "", ...jobs.map((job) => formatJob(job, includePrompt))].join("\n");
}

function formatHistory(ctx: ExtensionContext, scope?: CronScope, includePrompt = false): string {
	const jobs = visibleJobs(loadHistory(), ctx, scope);
	if (jobs.length === 0) return "No accessible completed one-shot cron jobs.";
	return [`Cron history (${jobs.length})`, "", ...jobs.map((job) => formatJob(job, includePrompt, true))].join("\n");
}

function formatStatus(ctx: ExtensionContext, scope?: CronScope): string {
	const daemon = getDaemonStatus();
	const launchd = getLaunchdStatus();
	const jobs = visibleJobs(loadJobs(), ctx, scope);
	const history = visibleJobs(loadHistory(), ctx, scope);
	const active = jobs.filter((job) => job.enabled).length;
	return [
		`Daemon (global): ${daemon.running ? `✅ running (PID ${daemon.pid})` : "⏸ not running"}`,
		daemon.stalePid ? `Stale PID: ${daemon.stalePid}` : undefined,
		`LaunchAgent (global): ${launchd.installed ? "✅ installed" : "⏸ not installed"} · ${launchd.loaded ? "loaded" : "not loaded"}`,
		`LaunchAgent plist: ${launchd.plistPath}`,
		`Accessible jobs: ${jobs.length} current · ${active} active · ${history.length} history${scope ? ` · scope ${scope}` : ""}`,
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
	if (!runAt || Number.isNaN(new Date(runAt).getTime())) throw new Error(`Invalid runAt timestamp: ${runAt}`);
}

function ensureLaunchdAndDaemon(): string[] {
	const messages: string[] = [];
	const launchd = getLaunchdStatus();
	if (!launchd.installed || !launchd.loaded) messages.push(installLaunchAgent().message);
	messages.push(startDaemon().message);
	return messages;
}

function upsertFromParams(params: CronToolParams, ctx: ExtensionContext): { job: CronJob; messages: string[] } {
	const job = withStoreTransaction((store) => {
		const rawRequested = params.id ? store.jobs.find((job) => job.id === params.id) : undefined;
		const provisionalName = params.name ?? rawRequested?.name ?? params.id;
		if (!provisionalName) throw new Error("name is required for upsert");
		const id = rawRequested?.id ?? allocateJobIdFromStore(store, provisionalName, params.id);
		const existing = rawRequested ?? store.jobs.find((job) => job.id === id);
		if (existing && !isAccessible(existing, ctx)) {
			throw new Error(`Cron job not found in the current accessible scope: ${params.id ?? id}`);
		}
		if (existing && params.scope && jobScope(existing) !== params.scope) {
			throw new Error("Changing a cron job scope is not supported. Create a new job in the target scope.");
		}
		const name = params.name ?? existing?.name;
		if (!name) throw new Error("name is required for upsert");
		const kind = params.kind ?? existing?.kind ?? "cron";
		const schedule = params.schedule ?? existing?.schedule;
		const runAt = params.runAt ?? existing?.runAt;
		validateJobInput(kind, schedule, runAt);
		const now = new Date().toISOString();
		const cwd = params.cwd ?? existing?.cwd ?? ctx.cwd;
		const scope = existing ? jobScope(existing) : (params.scope ?? "user");
		const owner = existing
			? { scope, projectId: existing.projectId, sessionId: existing.sessionId, sessionFile: existing.sessionFile }
			: ownerForScope(scope, ctx);
		const promptMarkdown = params.promptMarkdown;
		if (!promptMarkdown && !existing) throw new Error("promptMarkdown is required for new cron jobs");
		const promptFile = promptMarkdown ? writePromptFile(id, promptMarkdown) : existing?.promptFile;
		if (!promptFile) throw new Error("promptFile could not be resolved");
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
			cwd,
			promptFile,
			...owner,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			lastRunAt: existing?.lastRunAt,
			running: existing?.running ?? false,
			runToken: existing?.runToken,
			runPromptFile: existing?.runPromptFile,
			lastRunPromptFile: existing?.lastRunPromptFile,
			lastExitCode: existing?.lastExitCode,
			lastRunLog: existing?.lastRunLog,
			disabledReason: enabled ? undefined : existing?.disabledReason,
			completedAt: enabled ? undefined : existing?.completedAt,
		};
		const job = { ...baseJob, nextRunAt: calculateNextRun(baseJob, new Date()) };
		const index = store.jobs.findIndex((item) => item.id === id);
		if (index === -1) store.jobs.push(job);
		else store.jobs[index] = job;
		return job;
	});
	return { job, messages: ensureLaunchdAndDaemon() };
}

function requireId(params: CronToolParams, action: string): string {
	if (!params.id) throw new Error(`id is required for ${action}`);
	return params.id;
}

const toolHandlers: Record<
	CronAction,
	(params: CronToolParams, ctx: ExtensionContext) => Promise<CronToolResult> | CronToolResult
> = {
	list: (params, ctx) => {
		const jobs = visibleJobs(loadJobs(), ctx, params.scope);
		return { text: formatJobList(ctx, params.scope, Boolean(params.includePrompt)), details: { jobs } };
	},
	history: (params, ctx) => {
		const history = visibleJobs(loadHistory(), ctx, params.scope);
		return { text: formatHistory(ctx, params.scope, Boolean(params.includePrompt)), details: { history } };
	},
	status: (params, ctx) => {
		const jobs = visibleJobs(loadJobs(), ctx, params.scope);
		const history = visibleJobs(loadHistory(), ctx, params.scope);
		return {
			text: formatStatus(ctx, params.scope),
			details: { daemon: getDaemonStatus(), launchd: getLaunchdStatus(), jobs, history },
		};
	},
	upsert: (params, ctx) => {
		const { job, messages } = upsertFromParams(params, ctx);
		return {
			text: [`✓ Upserted cron job "${job.id}"`, "", formatJob(job), "", ...messages].join("\n"),
			details: { job, messages },
		};
	},
	update: (params, ctx) => {
		const existing = requireAccessibleJob(requireId(params, "update"), ctx, params.scope);
		const { job, messages } = upsertFromParams(
			{ ...params, action: "upsert", name: params.name ?? existing.name },
			ctx,
		);
		return {
			text: [`✓ Updated cron job "${job.id}"`, "", formatJob(job), "", ...messages].join("\n"),
			details: { job, messages },
		};
	},
	remove: (params, ctx) => {
		const job = removeAccessibleJob(requireId(params, "remove"), ctx, params.scope);
		if (!job) return { text: `Cron job not found: ${params.id}` };
		return { text: `✓ Removed cron job "${job.id}".`, details: { removed: job } };
	},
	enable: (params, ctx) => {
		const id = requireId(params, "enable");
		const job = updateAccessibleJob(id, ctx, params.scope, (current) => {
			const enabled = { ...current, enabled: true, disabledReason: undefined, completedAt: undefined };
			return { ...enabled, nextRunAt: calculateNextRun(enabled, new Date()) };
		});
		return { text: `✓ Enabled cron job "${job.id}". Next run: ${job.nextRunAt ?? "—"}`, details: { job } };
	},
	disable: (params, ctx) => {
		const id = requireId(params, "disable");
		const job = updateAccessibleJob(id, ctx, params.scope, (current) => ({
			...current,
			enabled: false,
			nextRunAt: undefined,
			disabledReason: "user_disabled",
		}));
		return { text: `✓ Disabled cron job "${job.id}".`, details: { job } };
	},
	run: (params, ctx) => {
		const id = requireId(params, "run");
		const job = updateAccessibleJob(id, ctx, params.scope, (current) => ({
			...current,
			enabled: true,
			nextRunAt: new Date().toISOString(),
			disabledReason: undefined,
		}));
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
			if (
				!ctx.hasUI ||
				!(await ctx.ui.confirm("Cron launchd 해제", "재부팅 후 cron daemon 자동 실행 등록을 제거할까요?"))
			) {
				return { text: "launchd uninstall cancelled." };
			}
		}
		const result = uninstallLaunchAgent();
		return { text: result.message, details: { result, launchd: getLaunchdStatus() } };
	},
};

export default function (pi: ExtensionAPI) {
	let sessionBridge: SessionBridge | undefined;
	let bridgeStart: Promise<void> | undefined;
	let shuttingDown = false;

	async function ensureSessionBridge(ctx: ExtensionContext, allowDrainingHandoff = false): Promise<void> {
		if (shuttingDown || sessionBridge) return;
		if (bridgeStart) return bridgeStart;
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		// Pi creates the session file only after the first assistant message.
		if (!sessionId || !sessionFile || !existsSync(sessionFile)) return;
		const bridge = new SessionBridge(sessionId, sessionFile, pi, { allowDrainingHandoff });
		bridgeStart = (async () => {
			await bridge.start();
			if (shuttingDown) await bridge.beginDraining();
			else sessionBridge = bridge;
		})();
		try {
			await bridgeStart;
		} finally {
			bridgeStart = undefined;
		}
	}

	pi.on("session_start", async (event, ctx) => {
		// Package updates replace files in place but cannot reload an external process. Schedule this
		// after the session hook returns so a draining daemon never delays Pi startup.
		setTimeout(() => {
			try {
				scheduleDaemonUpgrade();
			} catch {}
		}, 0);
		const sessionEvent = event as { reason?: string; previousSessionFile?: string };
		let allowDrainingHandoff = sessionEvent.reason === "reload";
		if (sessionEvent.previousSessionFile && ["new", "resume", "fork"].includes(sessionEvent.reason ?? "")) {
			try {
				const header = JSON.parse(readFileSync(sessionEvent.previousSessionFile, "utf8").split("\n", 1)[0]) as {
					id?: unknown;
				};
				if (typeof header.id === "string") {
					if (header.id === ctx.sessionManager.getSessionId()) allowDrainingHandoff = true;
					else releaseDrainingSessionOwner(header.id, sessionEvent.previousSessionFile);
				}
			} catch {}
		}
		await ensureSessionBridge(ctx, allowDrainingHandoff);
	});
	pi.on("agent_end", async (_event, ctx) => ensureSessionBridge(ctx));
	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		await bridgeStart?.catch(() => {});
		await sessionBridge?.beginDraining();
		sessionBridge = undefined;
	});

	pi.registerTool({
		name: "cron",
		label: "Cron",
		description:
			"CLI-style scheduler. New jobs default to user scope. Project jobs are isolated by Git identity; session jobs are delivered into the original persisted Pi session, using a live local bridge or same-session RPC resume.",
		promptSnippet: "Schedule and manage persistent user, project, or session cron jobs via `cron help`.",
		promptGuidelines: [
			"Use `cron help` before composing commands when needed. The tool accepts one CLI-style command string.",
			"New jobs default to user scope. Use `--scope project` for the current Git project. Use `--scope session` only when work must retain this session history and session-scoped memory.",
			"User and project jobs run headlessly and need self-contained promptMarkdown after `--`. Session jobs are delivered to the original session; their archived result means delivery was accepted or queued, not that the task succeeded.",
			"Scope changes are intentionally rejected. Create a new job in the target scope instead.",
		],
		parameters: CronParamsSchema,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const parsed = parseCronToolCommand((rawParams as { command: string }).command);
			if (parsed.type === "error")
				return {
					content: [{ type: "text" as const, text: `${parsed.message}\n\n${CRON_CLI_HELP_TEXT}` }],
					details: {},
					isError: true,
				};
			if (parsed.type === "help")
				return { content: [{ type: "text" as const, text: CRON_CLI_HELP_TEXT }], details: {} };
			const params = parsed.params as unknown as CronToolParams;
			if (params.scope === "session" && ["upsert", "update", "run", "enable"].includes(params.action)) {
				await ensureSessionBridge(ctx);
			}
			const result = await toolHandlers[params.action](params, ctx);
			return { content: [{ type: "text" as const, text: result.text }], details: result.details ?? {} };
		},
		renderCall(args, theme) {
			const command =
				typeof (args as { command?: unknown }).command === "string"
					? String((args as { command: string }).command).trim()
					: "cron help";
			const lines = command.split("\n");
			const preview = lines.slice(0, 5).join("\n");
			const suffix = lines.length > 5 ? `\n  ${theme.fg("muted", `... +${lines.length - 5} more lines`)}` : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("cron "))}${theme.fg("accent", "cli")}\n  ${theme.fg("dim", preview)}${suffix}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const raw = result.content[0];
			const text = (raw?.type === "text" ? raw.text : undefined) ?? "(no output)";
			if (expanded) return new Text(text, 0, 0);
			const lines = text.split("\n");
			return new Text(lines[0] + (lines.length > 1 ? theme.fg("muted", ` (+${lines.length - 1} lines)`) : ""), 0, 0);
		},
	});

	pi.registerCommand("cron", {
		description: "Persistent cron scheduler. Supports the same grammar as `cron help`, including --scope.",
		getArgumentCompletions: (prefix) => {
			const tokens = prefix.trimStart().split(/\s+/);
			if (tokens.length <= 1)
				return [
					"help",
					"status",
					"list",
					"history",
					"upsert",
					"update",
					"run",
					"remove",
					"enable",
					"disable",
					"start",
					"start-daemon",
					"stop",
					"stop-daemon",
					"install",
					"install-launchd",
					"uninstall",
					"uninstall-launchd",
				]
					.filter((value) => value.startsWith(tokens[0] ?? ""))
					.map((value) => ({ value, label: value }));
			return null;
		},
		handler: async (args, ctx) => {
			const parsed = parseCronToolCommand(`cron ${args?.trim() || "status"}`);
			if (parsed.type === "error") return ctx.ui.notify(parsed.message, "warning");
			if (parsed.type === "help") return ctx.ui.notify(CRON_CLI_HELP_TEXT, "info");
			try {
				const params = parsed.params as unknown as CronToolParams;
				if (params.scope === "session" && ["upsert", "update", "run", "enable"].includes(params.action)) {
					await ensureSessionBridge(ctx);
				}
				const result = await toolHandlers[params.action](params, ctx);
				ctx.ui.notify(result.text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
