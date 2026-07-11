import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

function getSubagentSessionDir(): string {
	return path.join(getAgentDir(), "sessions", "subagents");
}

function getEscalationsDir(): string {
	return path.join(getAgentDir(), "escalations");
}

function isSubagentSession(sessionFile: string | undefined): boolean {
	if (!sessionFile) return false;
	return (
		sessionFile.startsWith(`${getSubagentSessionDir()}${path.sep}`) ||
		sessionFile.startsWith(`${getSubagentSessionDir()}/`)
	);
}

export function writeEscalationRecord(sessionFile: string, message: string, context?: string): void {
	const escalationsDir = getEscalationsDir();
	if (!fs.existsSync(escalationsDir)) {
		fs.mkdirSync(escalationsDir, { recursive: true });
	}

	const record = {
		sessionFile,
		message,
		context,
		timestamp: new Date().toISOString(),
	};

	const sessionBasename = path.basename(sessionFile, ".jsonl");
	const escalationFile = path.join(escalationsDir, `${sessionBasename}.yaml`);
	fs.writeFileSync(escalationFile, stringifyYaml(record), "utf-8");
}

/**
 * ask_master Tool — registered only when the current session is a subagent session.
 *
 * When called:
 *   1. Writes escalation info to the agent directory's escalations/<session-basename>.yaml
 *   2. Exits with code 42 (ESCALATION_EXIT_CODE)
 *
 * The subagent runner detects exit code 42 and:
 *   - Reads + deletes the escalation file (IPC)
 *   - Surfaces the message to the master
 */
export function registerAskMasterTool(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!isSubagentSession(sessionFile)) return;

		pi.registerTool({
			name: "ask_master",
			label: "Ask Master",
			description: [
				"Calling this tool terminates the process immediately. No further work can be performed afterward.",
				"Sends a message to the master and terminates the current process.",
				"The master will review the message and respond appropriately.",
				"",
				"Use when:",
				"- A decision about how to proceed is required",
				"- Confirmation is needed before a risky operation such as deletion, deployment, or migration",
				"- An unexpected situation requires the master’s judgment",
			].join("\n"),
			promptSnippet: "Ask the master for a decision. WARNING: calling this tool terminates your session immediately.",
			promptGuidelines: [
				"ask_master terminates your process — only call when you truly cannot proceed without the master's decision.",
				"Exhaust available tools and context first before resorting to ask_master.",
				"When calling, always include actionable options and your recommendation in the message.",
			],
			parameters: Type.Object({
				message: Type.String({
					description:
						"Message for the master. Explain why a decision is needed, what must be decided, the available options, and your recommendation.",
				}),
				context: Type.Optional(
					Type.String({
						description: "Additional context, such as current progress, discovered issues, and options",
					}),
				),
			}),
			execute: async (_toolCallId, rawParams) => {
				const params = rawParams as { message: string; context?: string };
				const activeSessionFile = sessionFile;
				if (!activeSessionFile) {
					return {
						content: [
							{
								type: "text" as const,
								text: "[ask_master] Error: Missing subagent session file. Escalation not written.",
							},
						],
						details: { message: params.message, context: params.context, error: true },
						terminate: true,
					};
				}

				try {
					writeEscalationRecord(activeSessionFile, params.message, params.context);
				} catch (err) {
					process.stderr.write(`[ask_master] Failed to write escalation file: ${err}\n`);
				}

				return {
					content: [{ type: "text" as const, text: `Escalated to master: ${params.message}` }],
					details: { message: params.message, context: params.context, error: false },
					terminate: true,
				};
			},
		});
	});
}

/**
 * Exit code used by the 'escalate' tool to signal that the
 * subagent wants to escalate to the master.
 */
export const ESCALATION_EXIT_CODE = 42;

export interface EscalationRecord {
	sessionFile: string;
	message: string;
	context?: string;
	timestamp: string;
}

/**
 * Derive the escalation IPC file path from a subagent session file.
 */
export function getEscalationFilePath(sessionFile: string): string {
	const basename = path.basename(sessionFile, ".jsonl");
	return path.join(getEscalationsDir(), `${basename}.yaml`);
}

/**
 * Read the escalation IPC file and delete it immediately (consume-once pattern).
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readAndConsumeEscalation(sessionFile: string): EscalationRecord | null {
	try {
		const filePath = getEscalationFilePath(sessionFile);
		if (!fs.existsSync(filePath)) return null;
		const content = fs.readFileSync(filePath, "utf-8");
		const record = parseYaml(content) as EscalationRecord;
		try {
			fs.unlinkSync(filePath);
		} catch {
			/* ignore deletion errors */
		}
		return record;
	} catch {
		return null;
	}
}
