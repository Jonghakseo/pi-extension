/**
 * CLI-style command parser for the subagent tool.
 *
 * LLM-facing interface: { command: "subagent ..." }
 */

type ContextMode = "main" | "isolated";

type BatchOrChainBlock = {
	agent: string;
	task: string;
};

export type SubagentCliParseResult =
	| { type: "help" }
	| { type: "agents" }
	| { type: "params"; params: Record<string, unknown> }
	| { type: "error"; message: string };

export const SUBAGENT_CLI_HELP_TEXT = [
	"Subagent CLI (LLM interface)",
	"",
	'Always call with: { command: "..." }',
	"",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"📌 KEY RULES",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"",
	"1. Task separator `--` is REQUIRED for run/continue:",
	"   ✓ subagent run worker -- perform the task",
	"   ✗ subagent run worker perform the task  ← Missing `--`",
	"",
	"2. RUN vs CONTINUE:",
	"   • run:      Start a NEW subagent execution (must specify agent name)",
	"   • continue: Resume an EXISTING run's session by its runId; reuses conversation context",
	"              but does NOT automatically sync the latest main context (provide it explicitly if needed)",
	"",
	"3. BATCH vs CHAIN:",
	"   • batch:    Launch MULTIPLE independent runs in parallel",
	"   • chain:    Launch MULTIPLE dependent steps sequentially; previous output is passed as reference",
	"              Each block must be exactly: --agent <agent> --task <task>",
	"",
	"4. Follow-up policy:",
	"   • After a launch, do NOT call `subagent status/detail` to poll right away.",
	"   • Stop making subagent calls and wait for the automatic completion/failure follow-up.",
	"   • Use `status/detail` only when the USER explicitly asks (or for one-off manual inspection).",
	"",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"COMMANDS",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"",
	"  Info & Listing:",
	"    subagent help",
	"    subagent agents",
	"    subagent runs",
	"    subagent status <runId>",
	"    subagent detail <runId>",
	"",
	"  Execution:",
	"    subagent run <agent> [--main|--isolated] -- <task>",
	"    subagent continue <runId> [--agent <agent>] [--main|--isolated] -- <task>",
	"    subagent batch [--main|--isolated] --agent <agent> --task <task> --agent <agent> --task <task> ...",
	"    subagent chain [--main|--isolated] --agent <agent> --task <task> --agent <agent> --task <task> ...",
	"",
	"  Cleanup:",
	"    subagent abort <runId|runId,runId|all>",
	"    subagent remove <runId|runId,runId|all>",
	"",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"EXAMPLES",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"",
	"  New run:",
	"    subagent run worker -- improve login performance",
	"",
	"  Continue existing run (runId 22):",
	"    subagent continue 22 -- finish the previous work and commit it",
	"",
	"  Parallel batch:",
	'    subagent batch --main --agent worker --task "implement feature A" --agent reviewer --task "review code B"',
	"",
	"  Sequential chain:",
	'    subagent chain --main --agent worker --task "implement the login API" --agent reviewer --task "review the previous result"',
	"",
	"  Manual status & cleanup (occasional checks):",
	"    subagent runs",
	"    subagent status 22",
	"    subagent detail 22",
	"    subagent abort 22",
	"    subagent remove all",
	"",
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
	"",
	"💡 Tips:",
	"  • Runs notify you when done automatically.",
	"  • Batch waits for the whole group; chain waits for the whole pipeline.",
	"  • After launch, end the turn and wait for follow-up (no status/detail polling loops).",
	"  • Use `--main` to share context with the main agent; `--isolated` for a fresh scope.",
	"  • When using `continue`, the main context is NOT auto-synced. Include recent changes in the task text.",
	"  • Long task? Write context to a temp file and reference it in the task:",
	'    e.g. subagent run worker -- "read /tmp/task-ctx.md and follow the instructions"',
	"",
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
			current += ch;
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

	if (escaped) {
		current += "\\";
	}

	if (quote) {
		return { error: "Unclosed quote in command." };
	}

	if (current) tokens.push(current);
	return { tokens };
}

function parseInteger(raw: string): number | null {
	if (!/^\d+$/.test(raw)) return null;
	const value = Number.parseInt(raw, 10);
	return Number.isInteger(value) ? value : null;
}

function parseRunTarget(
	raw: string,
	knownRunIds: number[] | undefined,
): { runId: number } | { runIds: number[] } | { error: string } {
	if (!raw) return { error: "Missing run target." };

	if (raw.toLowerCase() === "all") {
		const unique = Array.from(new Set((knownRunIds ?? []).filter((id) => Number.isInteger(id))));
		if (unique.length === 0) {
			return { error: "No runs available for target `all`." };
		}
		return { runIds: unique };
	}

	if (raw.includes(",")) {
		const ids = raw
			.split(",")
			.map((part) => parseInteger(part.trim()))
			.filter((id): id is number => id !== null);
		if (ids.length === 0) return { error: `Invalid run target: ${raw}` };
		const unique = Array.from(new Set(ids));
		return unique.length === 1 ? { runId: unique[0] } : { runIds: unique };
	}

	const runId = parseInteger(raw);
	if (runId === null) return { error: `Invalid runId: ${raw}` };
	return { runId };
}

function parseRunLike(
	verb: "run" | "continue",
	args: string[],
): { params: Record<string, unknown> } | { error: string } {
	const sepIndex = args.indexOf("--");
	if (sepIndex === -1) {
		const example =
			verb === "run"
				? "subagent run worker -- perform the task"
				: "subagent continue 22 -- continue with the next step";
		return {
			error: `❌ Missing task separator \`--\`\n\nThe \`--\` is REQUIRED to separate options from task text.\n\n✓ Correct: ${example}\n✗ Wrong:  subagent ${verb} ${args.join(" ")}`,
		};
	}

	const head = args.slice(0, sepIndex);
	const task = args
		.slice(sepIndex + 1)
		.join(" ")
		.trim();
	if (!task)
		return {
			error: `❌ Empty task after \`--\`\n\nProvide a non-empty task description after the separator.\n\n✓ Correct: subagent ${verb} ${head.join(" ")} -- <your task here>`,
		};

	let runId: number | undefined;
	let agent: string | undefined;
	let contextMode: ContextMode | undefined;

	for (let i = 0; i < head.length; i++) {
		const token = head[i];

		if (token === "--main") {
			contextMode = "main";
			continue;
		}
		if (token === "--isolated") {
			contextMode = "isolated";
			continue;
		}
		if (token === "--async" || token === "--sync") {
			return {
				error: `❌ ${token} is no longer supported\n\nSubagent run/continue commands are async-only, so you should omit execution-mode flags entirely. Wait for the automatic follow-up message after launch.\n\n✓ Correct: ${verb === "continue" ? "subagent continue 22 -- <task>" : "subagent run worker -- <task>"}`,
			};
		}
		if (token === "--agent") {
			const value = head[i + 1];
			if (!value)
				return {
					error: `❌ --agent requires a value\n\n✓ Correct:  subagent continue 22 --agent worker -- <task>\n✓ Or:       subagent continue 22 --agent=worker -- <task>`,
				};
			agent = value;
			i++;
			continue;
		}
		if (token.startsWith("--agent=")) {
			agent = token.slice("--agent=".length);
			continue;
		}

		if (token.startsWith("--")) {
			return {
				error: `❌ Unknown option: ${token}\n\nValid options: --main, --isolated${verb === "continue" ? ", --agent" : ""}\n\n✓ Example: subagent ${verb} ${token === "--main" ? "" : verb === "continue" ? "22 " : ""}${token} -- <task>`,
			};
		}

		if (verb === "continue") {
			if (runId === undefined) {
				const parsed = parseInteger(token);
				if (parsed === null)
					return {
						error: `❌ continue requires numeric runId, got: "${token}"\n\nThe runId must be a number (see 'subagent runs' to list all run IDs).\n\n✓ Correct: subagent continue 22 -- <task>`,
					};
				runId = parsed;
				continue;
			}
			return {
				error: `❌ Unexpected argument: ${token}\n\nAfter runId, only options (--main, --isolated, --agent) or the separator \`--\` are allowed.\n\n✓ Correct: subagent continue ${runId} --main -- <task>`,
			};
		}

		if (!agent) {
			agent = token;
			continue;
		}
		return {
			error: `❌ Unexpected argument: ${token}\n\nAfter agent name, only options (--main, --isolated) or the separator \`--\` are allowed.\n\n✓ Correct: subagent run ${agent} --main -- <task>`,
		};
	}

	if (verb === "continue" && runId === undefined) {
		return {
			error: `❌ continue requires <runId>\n\nYou must specify a runId (numeric). Use 'subagent runs' to list all.\n\n✓ Example: subagent continue 22 -- <task>`,
		};
	}

	const params: Record<string, unknown> = { task };
	if (verb === "continue") {
		params.runId = runId;
		if (agent) params.agent = agent;
	} else {
		params.agent = agent ?? "worker";
	}
	if (contextMode) params.contextMode = contextMode;

	return { params };
}

function parseBatchOrChain(
	verb: "batch" | "chain",
	args: string[],
): { params: Record<string, unknown> } | { error: string } {
	let contextMode: ContextMode | undefined;
	const blocks: BatchOrChainBlock[] = [];
	let index = 0;
	let sawBlock = false;

	while (index < args.length) {
		const token = args[index];

		if (!sawBlock && (token === "--main" || token === "--isolated")) {
			contextMode = token === "--main" ? "main" : "isolated";
			index++;
			continue;
		}

		if (token !== "--agent") {
			if (token === "--task") {
				return {
					error:
						`❌ ${verb} blocks must start with \`--agent <agent> --task <task>\`\n\n` +
						`Found \`--task\` before \`--agent\`.\n\n` +
						`✓ Example: subagent ${verb} --main --agent worker --task "task A" --agent reviewer --task "task B"`,
				};
			}
			if (token.startsWith("--")) {
				return {
					error:
						`❌ Unknown or misplaced option: ${token}\n\n` +
						`Valid ${verb} syntax: subagent ${verb} [--main|--isolated] --agent <agent> --task <task> --agent <agent> --task <task> ...`,
				};
			}
			return {
				error:
					`❌ ${verb} does not allow free text outside \`--task\` blocks\n\n` +
					`Unexpected token: ${token}\n\n` +
					`✓ Example: subagent ${verb} --agent worker --task "task A" --agent reviewer --task "task B"`,
			};
		}

		sawBlock = true;
		const agent = args[index + 1];
		if (!agent || agent.startsWith("--")) {
			return {
				error:
					`❌ ${verb} requires \`--agent <value>\`\n\n` +
					`✓ Example: subagent ${verb} --agent worker --task "task A" --agent reviewer --task "task B"`,
			};
		}

		const taskFlag = args[index + 2];
		if (taskFlag !== "--task") {
			return {
				error:
					`❌ ${verb} blocks must be exactly \`--agent <agent> --task <task>\`\n\n` +
					`After \`--agent ${agent}\`, expected \`--task\`.`,
			};
		}

		const task = args[index + 3];
		if (!task || task.startsWith("--")) {
			return {
				error:
					`❌ ${verb} requires \`--task <value>\`\n\n` +
					`✓ Example: subagent ${verb} --agent worker --task "task A" --agent reviewer --task "task B"`,
			};
		}

		blocks.push({ agent, task });
		index += 4;
	}

	if (blocks.length < 2) {
		return {
			error:
				`❌ ${verb} requires at least 2 blocks\n\n` +
				`Use repeated \`--agent <agent> --task <task>\` blocks.\n\n` +
				`✓ Example: subagent ${verb} --agent worker --task "task A" --agent reviewer --task "task B"`,
		};
	}

	return {
		params: {
			asyncAction: verb,
			...(contextMode ? { contextMode } : {}),
			...(verb === "batch" ? { runs: blocks } : { steps: blocks }),
		},
	};
}

function extractVerb(tokens: string[]): { verb: string; args: string[] } {
	if (tokens.length === 0) return { verb: "help", args: [] };
	if (tokens[0] === "subagent") {
		if (tokens.length === 1) return { verb: "help", args: [] };
		return { verb: tokens[1], args: tokens.slice(2) };
	}
	return { verb: tokens[0], args: tokens.slice(1) };
}

export function parseSubagentCommandVerb(command: unknown): string | null {
	if (typeof command !== "string") return null;
	const trimmed = command.trim();
	if (!trimmed) return null;
	const tokenized = tokenizeCli(trimmed);
	if ("error" in tokenized) return null;
	return extractVerb(tokenized.tokens).verb;
}

export function isSubagentAsyncLaunchCommand(command: unknown): boolean {
	if (typeof command !== "string") return false;
	const trimmed = command.trim();
	if (!trimmed) return false;
	const tokenized = tokenizeCli(trimmed);
	if ("error" in tokenized) return false;
	const { verb } = extractVerb(tokenized.tokens);
	return verb === "run" || verb === "continue" || verb === "batch" || verb === "chain";
}

export function parseSubagentToolCommand(
	command: unknown,
	options: { knownRunIds?: number[] } = {},
): SubagentCliParseResult {
	if (typeof command !== "string") {
		return {
			type: "error",
			message: `❌ Missing or invalid command parameter\n\nThe 'command' parameter must be a string.\n\n✓ Correct: { command: "subagent help" }\n✗ Wrong:   { command: 123 }\n\nTry: subagent help`,
		};
	}

	const trimmed = command.trim();
	if (!trimmed) {
		return {
			type: "error",
			message: `❌ Empty command\n\nYou must provide a valid subagent command.\n\n✓ Try: subagent help\n✓ Try: subagent runs\n✓ Try: subagent run worker -- task description`,
		};
	}

	const tokenized = tokenizeCli(trimmed);
	if ("error" in tokenized) {
		return {
			type: "error",
			message: `❌ Syntax error: ${tokenized.error}\n\nCheck that quotes are balanced and the command is well-formed.\n\n✓ Correct: subagent run worker -- "task with spaces"`,
		};
	}

	const { verb, args } = extractVerb(tokenized.tokens);

	switch (verb) {
		case "help":
			return { type: "help" };

		case "agents":
			return { type: "agents" };

		case "runs":
			return { type: "params", params: { asyncAction: "list" } };

		case "status": {
			const runIdRaw = args[0];
			if (!runIdRaw)
				return {
					type: "error",
					message: `❌ status requires <runId>\n\n✓ Example: subagent status 22\n\nSee all runs with: subagent runs`,
				};
			const runId = parseInteger(runIdRaw);
			if (runId === null)
				return {
					type: "error",
					message: `❌ Invalid runId: "${runIdRaw}"\n\nThe runId must be a number. See all runs with: subagent runs`,
				};
			return { type: "params", params: { asyncAction: "status", runId } };
		}

		case "detail": {
			const runIdRaw = args[0];
			if (!runIdRaw)
				return {
					type: "error",
					message: `❌ detail requires <runId>\n\n✓ Example: subagent detail 22\n\nSee all runs with: subagent runs`,
				};
			const runId = parseInteger(runIdRaw);
			if (runId === null)
				return {
					type: "error",
					message: `❌ Invalid runId: "${runIdRaw}"\n\nThe runId must be a number. See all runs with: subagent runs`,
				};
			return { type: "params", params: { asyncAction: "detail", runId } };
		}

		case "abort":
		case "remove": {
			const target = args[0];
			if (!target)
				return {
					type: "error",
					message: `❌ ${verb} requires <runId|runId,runId|all>\n\n✓ Examples:\n  subagent ${verb} 22\n  subagent ${verb} 22,23,24\n  subagent ${verb} all`,
				};
			const parsedTarget = parseRunTarget(target, options.knownRunIds);
			if ("error" in parsedTarget)
				return {
					type: "error",
					message: `❌ Invalid target: "${target}"\n\n${parsedTarget.error}`,
				};
			return {
				type: "params",
				params: {
					asyncAction: verb,
					...parsedTarget,
				},
			};
		}

		case "run": {
			const parsed = parseRunLike("run", args);
			if ("error" in parsed) return { type: "error", message: parsed.error };
			return { type: "params", params: parsed.params };
		}

		case "continue": {
			const parsed = parseRunLike("continue", args);
			if ("error" in parsed) return { type: "error", message: parsed.error };
			return { type: "params", params: parsed.params };
		}

		case "batch": {
			const parsed = parseBatchOrChain("batch", args);
			if ("error" in parsed) return { type: "error", message: parsed.error };
			return { type: "params", params: parsed.params };
		}

		case "chain": {
			const parsed = parseBatchOrChain("chain", args);
			if ("error" in parsed) return { type: "error", message: parsed.error };
			return { type: "params", params: parsed.params };
		}

		default:
			return {
				type: "error",
				message: `❌ Unknown subcommand: "${verb}"\n\nValid commands: help, agents, run, continue, batch, chain, runs, status, detail, abort, remove\n\n✓ Try: subagent help`,
			};
	}
}
