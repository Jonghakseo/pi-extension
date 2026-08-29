/**
 * CLI-style command parser for the cron tool.
 *
 * LLM-facing interface: { command: "cron ..." }
 */

export type CronCliParseResult =
	| { type: "help" }
	| { type: "params"; params: Record<string, unknown> }
	| { type: "error"; message: string };

export const CRON_CLI_HELP_TEXT = [
	"Cron CLI (LLM interface)",
	"",
	'Always call with: { command: "..." }',
	"",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"📌 KEY RULES",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"",
	"1. Start with `cron help` when you need to learn the interface.",
	"",
	"2. Scheduled prompts must be self-contained:",
	"   • Headless cron runs do NOT have access to the original chat/session history.",
	"   • If the user says '방금 한 것', '이 작업', or '아까 정리한 것', include all required context after `--`.",
	"",
	"3. Use `--` to separate options from prompt markdown for upsert/update:",
	'   ✓ cron upsert --name daily --kind cron --schedule "0 10 * * *" -- <self-contained prompt>',
	"   ✗ cron upsert --name daily --kind cron --schedule 0 10 * * * <prompt>  ← quote schedule and use `--`",
	"",
	"4. One-shot jobs:",
	"   • `kind at` and `kind delay` are one-shot automatically.",
	"   • For a cron expression that should run once, pass `--once`.",
	"",
	"5. Destructive actions:",
	"   • cron remove <id> deletes the job immediately",
	"   • cron uninstall-launchd --yes explicitly confirms launchd uninstall without an extra UI dialog",
	"",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"COMMANDS",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"",
	"  Info & Listing:",
	"    cron help",
	"    cron status",
	"    cron list [--include-prompt]",
	"",
	"  Job Management:",
	"    cron upsert [<id>] --name <name> --kind <cron|at|delay> (--schedule <expr>|--run-at <iso>) [--cwd <path>] [--enabled <true|false>] [--once] -- <promptMarkdown>",
	"    cron update <id> [--name <name>] [--kind <cron|at|delay>] [--schedule <expr>] [--run-at <iso>] [--cwd <path>] [--enabled <true|false>] [--once|--once=false] [-- <promptMarkdown>]",
	"    cron run <id>",
	"    cron enable <id>",
	"    cron disable <id>",
	"    cron remove <id>",
	"",
	"  Daemon / launchd:",
	"    cron start-daemon        (alias: cron start)",
	"    cron stop-daemon         (alias: cron stop)",
	"    cron install-launchd     (alias: cron install)",
	"    cron uninstall-launchd [--yes]  (alias: cron uninstall)",
	"",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"EXAMPLES",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"",
	"  Daily recurring job:",
	'    cron upsert --name "daily-release-check" --kind cron --schedule "0 10 * * *" -- "# Daily release check\\n\\nRun the following checks..."',
	"",
	"  One-shot job at a timestamp:",
	'    cron upsert --name "qa-follow-up" --kind at --run-at "2026-05-01T09:00:00+09:00" -- "# QA follow-up\\n\\nContext and checklist..."',
	"",
	"  Delay-style one-shot job (runAt must still be an ISO timestamp):",
	'    cron upsert --name "two-hour-reminder" --kind delay --run-at "2026-04-30T15:00:00+09:00" -- "# Reminder\\n\\nSelf-contained task..."',
	"",
	"  Update schedule without changing prompt:",
	'    cron update daily-release-check --schedule "30 9 * * 1-5"',
	"",
	"  Manual status & cleanup:",
	"    cron list",
	"    cron status",
	"    cron run daily-release-check",
	"    cron remove daily-release-check",
	"",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
].join("\n");

type TokenizeResult = { tokens: string[] } | { error: string };

function tokenizeCli(input: string): TokenizeResult {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];

		if (escaped) {
			current += ch === "n" ? "\n" : ch === "t" ? "\t" : ch;
			escaped = false;
			continue;
		}

		if (ch === "\\") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}

		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += ch;
	}

	if (escaped) current += "\\";
	if (quote) return { error: "Unclosed quote in command." };
	if (current) tokens.push(current);
	return { tokens };
}

function extractVerb(tokens: string[]): { verb: string; args: string[] } {
	if (tokens.length === 0) return { verb: "help", args: [] };
	if (tokens[0] === "cron") {
		if (tokens.length === 1) return { verb: "help", args: [] };
		return { verb: tokens[1], args: tokens.slice(2) };
	}
	return { verb: tokens[0], args: tokens.slice(1) };
}

function parseBoolean(raw: string, option: string): boolean | { error: string } {
	if (raw === "true") return true;
	if (raw === "false") return false;
	return { error: `❌ ${option} requires true or false, got: "${raw}"` };
}

function normalizeOptionName(raw: string): string {
	return raw.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

type ParsedOptions =
	| { params: Record<string, unknown>; promptMarkdown?: string; positional: string[] }
	| { error: string };

function parseOptions(args: string[], options: { allowPrompt: boolean }): ParsedOptions {
	const params: Record<string, unknown> = {};
	const positional: string[] = [];
	let promptMarkdown: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const token = args[i];

		if (token === "--") {
			if (!options.allowPrompt) {
				return { error: "❌ This command does not accept prompt markdown after `--`." };
			}
			promptMarkdown = args
				.slice(i + 1)
				.join(" ")
				.trim();
			break;
		}

		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}

		const eqIndex = token.indexOf("=");
		const rawName = eqIndex === -1 ? token.slice(2) : token.slice(2, eqIndex);
		const optionName = normalizeOptionName(rawName);
		const inlineValue = eqIndex === -1 ? undefined : token.slice(eqIndex + 1);
		const takeValue = () => {
			if (inlineValue !== undefined) return inlineValue;
			const value = args[i + 1];
			if (!value || value.startsWith("--")) return undefined;
			i++;
			return value;
		};

		switch (optionName) {
			case "id": {
				const value = takeValue();
				if (!value) return { error: "❌ --id requires a value" };
				params.id = value;
				break;
			}
			case "name": {
				const value = takeValue();
				if (!value) return { error: "❌ --name requires a value" };
				params.name = value;
				break;
			}
			case "kind": {
				const value = takeValue();
				if (!value) return { error: "❌ --kind requires a value: cron, at, or delay" };
				if (!["cron", "at", "delay"].includes(value)) {
					return { error: `❌ Invalid --kind: "${value}"\n\nValid values: cron, at, delay` };
				}
				params.kind = value;
				break;
			}
			case "schedule": {
				const value = takeValue();
				if (!value) return { error: "❌ --schedule requires a quoted 5-field cron expression" };
				params.schedule = value;
				break;
			}
			case "run-at": {
				const value = takeValue();
				if (!value) return { error: "❌ --run-at requires an ISO timestamp" };
				params.runAt = value;
				break;
			}
			case "cwd": {
				const value = takeValue();
				if (!value) return { error: "❌ --cwd requires a path" };
				params.cwd = value;
				break;
			}
			case "enabled": {
				const value = takeValue();
				if (!value) return { error: "❌ --enabled requires true or false" };
				const parsed = parseBoolean(value, "--enabled");
				if (typeof parsed !== "boolean") return { error: parsed.error };
				params.enabled = parsed;
				break;
			}
			case "once": {
				const value = inlineValue ?? args[i + 1];
				if (inlineValue === undefined && value && !value.startsWith("--")) {
					i++;
					const parsed = parseBoolean(value, "--once");
					if (typeof parsed !== "boolean") return { error: parsed.error };
					params.once = parsed;
				} else if (inlineValue !== undefined) {
					const parsed = parseBoolean(inlineValue, "--once");
					if (typeof parsed !== "boolean") return { error: parsed.error };
					params.once = parsed;
				} else {
					params.once = true;
				}
				break;
			}
			case "include-prompt":
				params.includePrompt = true;
				break;
			case "yes":
				params.yes = true;
				break;
			default:
				return { error: `❌ Unknown option: --${rawName}\n\nTry: cron help` };
		}
	}

	return { params, promptMarkdown, positional };
}

function parseIdCommand(action: string, args: string[]): CronCliParseResult {
	const id = args[0];
	if (!id) {
		return {
			type: "error",
			message: `❌ ${action} requires <id>\n\n✓ Example: cron ${action} daily-release-check`,
		};
	}
	if (args.length > 1) {
		return {
			type: "error",
			message: `❌ Unexpected argument: ${args[1]}\n\n✓ Example: cron ${action} ${id}`,
		};
	}
	return { type: "params", params: { action, id } };
}

function parseUpsertOrUpdate(action: "upsert" | "update", args: string[]): CronCliParseResult {
	const parsed = parseOptions(args, { allowPrompt: true });
	if ("error" in parsed) return { type: "error", message: parsed.error };

	const params: Record<string, unknown> = { action, ...parsed.params };
	if (parsed.promptMarkdown) params.promptMarkdown = parsed.promptMarkdown;

	if (parsed.positional.length > 1) {
		return {
			type: "error",
			message: `❌ Unexpected arguments: ${parsed.positional.slice(1).join(" ")}\n\nUse at most one positional id. Try: cron help`,
		};
	}
	if (parsed.positional[0]) {
		if (params.id) return { type: "error", message: "❌ Provide id either positionally or with --id, not both." };
		params.id = parsed.positional[0];
	}
	if (action === "update" && !params.id) {
		return {
			type: "error",
			message: '❌ update requires <id>\n\n✓ Example: cron update daily-release-check --schedule "0 9 * * *"',
		};
	}
	return { type: "params", params };
}

function parseList(args: string[]): CronCliParseResult {
	const parsed = parseOptions(args, { allowPrompt: false });
	if ("error" in parsed) return { type: "error", message: parsed.error };
	if (parsed.positional.length > 0) {
		return { type: "error", message: `❌ list does not accept positional arguments: ${parsed.positional.join(" ")}` };
	}
	return { type: "params", params: { action: "list", ...parsed.params } };
}

export function parseCronToolCommand(command: unknown): CronCliParseResult {
	if (typeof command !== "string") {
		return {
			type: "error",
			message: `❌ Missing or invalid command parameter\n\nThe 'command' parameter must be a string.\n\n✓ Correct: { command: "cron help" }`,
		};
	}

	const trimmed = command.trim();
	if (!trimmed) {
		return {
			type: "error",
			message: "❌ Empty command\n\n✓ Try: cron help\n✓ Try: cron list\n✓ Try: cron status",
		};
	}

	const tokenized = tokenizeCli(trimmed);
	if ("error" in tokenized) {
		return {
			type: "error",
			message: `❌ Syntax error: ${tokenized.error}\n\nCheck that quotes are balanced.\n\n✓ Correct: cron upsert --name daily --kind cron --schedule "0 10 * * *" -- "prompt"`,
		};
	}

	const { verb, args } = extractVerb(tokenized.tokens);

	switch (verb) {
		case "help":
			return { type: "help" };
		case "status":
			if (args.length > 0)
				return { type: "error", message: "❌ status does not accept arguments\n\n✓ Example: cron status" };
			return { type: "params", params: { action: "status" } };
		case "list":
			return parseList(args);
		case "upsert":
		case "schedule":
			return parseUpsertOrUpdate("upsert", args);
		case "update":
			return parseUpsertOrUpdate("update", args);
		case "run":
		case "enable":
		case "disable":
		case "remove":
			return parseIdCommand(verb, args);
		case "delete":
		case "rm":
			return parseIdCommand("remove", args);
		case "start":
		case "start-daemon":
			return { type: "params", params: { action: "start_daemon" } };
		case "stop":
		case "stop-daemon":
			return { type: "params", params: { action: "stop_daemon" } };
		case "install":
		case "install-launchd":
			return { type: "params", params: { action: "install_launchd" } };
		case "uninstall":
		case "uninstall-launchd": {
			const parsed = parseOptions(args, { allowPrompt: false });
			if ("error" in parsed) return { type: "error", message: parsed.error };
			if (parsed.positional.length > 0) {
				return {
					type: "error",
					message: `❌ ${verb} does not accept positional arguments: ${parsed.positional.join(" ")}`,
				};
			}
			return { type: "params", params: { action: "uninstall_launchd", ...parsed.params } };
		}
		default:
			return {
				type: "error",
				message: `❌ Unknown subcommand: "${verb}"\n\nValid commands: help, status, list, upsert, update, run, enable, disable, remove, start-daemon, stop-daemon, install-launchd, uninstall-launchd\n\n✓ Try: cron help`,
			};
	}
}
