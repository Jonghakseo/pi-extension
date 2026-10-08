/**
 * Test-only provider for the Task worker PoC. It never reaches the network: it reads the last real
 * user message, follows a `CMD:` directive from it, and appends one JSON line per model call to
 * `PI_TASK_TEST_MARKERS` so the test can observe the child without extra tooling.
 *
 * Not part of the published package.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage, StopReason, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

type Content = { type: string; text?: string };
type Message = { role?: string; content?: string | Content[]; customType?: string };
type Context = { messages?: Message[] };

const MARKERS = process.env.PI_TASK_TEST_MARKERS ?? "";
/** bash-async nudges the model with this while a job runs; it is not a new instruction. */
const REMINDER = "Still running or awaiting delivery";
const COMPLETION = "bash_async";

function textOf(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return (message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function mark(record: Record<string, unknown>): void {
	if (!MARKERS) return;
	appendFileSync(MARKERS, `${JSON.stringify(record)}\n`);
}

/** The newest real instruction: a user message that is neither a running reminder nor a job completion. */
function lastDirective(messages: Message[]): { index: number; text: string } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const text = textOf(message);
		if (text.includes(REMINDER)) continue;
		return { index, text };
	}
	return { index: -1, text: "" };
}

function isCompletion(message: Message | undefined): boolean {
	if (message?.role !== "user") return false;
	if (message.customType === "bash-async-completion") return true;
	const text = textOf(message);
	return text.includes(COMPLETION) && /exit \d/.test(text) && !text.includes(REMINDER);
}

function parseDirective(text: string): { verb: string; args: string[] } | undefined {
	const match = /CMD:([A-Z_]+)([^\n]*)/.exec(text);
	if (!match) return undefined;
	return { verb: match[1] ?? "", args: (match[2] ?? "").trim().split(/\s+/).filter(Boolean) };
}

export default function fakeProvider(pi: {
	registerProvider(name: string, provider: Record<string, unknown>): void;
}): void {
	pi.registerProvider("task-fake", {
		api: "task-fake-api",
		apiKey: "offline-test-only",
		baseUrl: "http://127.0.0.1:1",
		models: ["mock-a", "mock-b"].map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1_000,
		})),
		streamSimple(
			model: { id: string; api: string; provider: string },
			context: Context,
			options?: { signal?: AbortSignal },
		) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api as AssistantMessage["api"],
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			let reason: Extract<StopReason, "stop" | "toolUse"> = "stop";
			const emitToolCall = (call: Omit<ToolCall, "type">) => {
				message.content = [{ type: "toolCall", ...call }];
				reason = "toolUse";
			};
			const messages = context.messages ?? [];
			const last = messages[messages.length - 1];
			const directive = lastDirective(messages);
			const parsed = parseDirective(directive.text);
			// Once this directive produced a tool call, the follow-up call must not repeat it.
			const answered = messages.slice(directive.index + 1).some((entry) => {
				if (entry?.role !== "assistant") return false;
				const content = Array.isArray(entry.content) ? entry.content : [];
				return content.some((part) => part.type === "toolCall");
			});
			// Only the call that directly follows a tool result reports it, so the test can count results.
			const toolResult = (last?.role === "toolResult" ? last : undefined) as
				| (Message & { toolName?: string; isError?: boolean })
				| undefined;

			void (async () => {
				stream.push({ type: "start", partial: message });
				const emitText = (text: string) => {
					message.content = [{ type: "text", text }];
					reason = "stop";
					mark({ kind: "reply", model: model.id, text });
				};
				if (isCompletion(last)) {
					mark({ kind: "completion", model: model.id, text: textOf(last).slice(0, 200) });
					emitText("COMPLETION_SEEN");
				} else if (!parsed) {
					mark({ kind: "idle", model: model.id });
					emitText("IDLE");
				} else {
					mark({
						kind: answered ? "after-tool" : parsed.verb.toLowerCase(),
						verb: parsed.verb,
						args: parsed.args,
						model: model.id,
						toolResult: toolResult
							? {
									name: toolResult.toolName,
									isError: toolResult.isError === true,
									text: textOf(toolResult).slice(0, 300),
								}
							: undefined,
					});
					if (answered) {
						emitText(`DONE:${parsed.verb}`);
					} else if (parsed.verb === "START_JOB") {
						const [logFile, seconds] = parsed.args;
						// Written to a file so no quoting of JavaScript has to survive a shell.
						const scriptPath = join(dirname(MARKERS), `job-script-${Date.now()}.cjs`);
						writeFileSync(
							scriptPath,
							[
								"const fs = require('node:fs');",
								"const log = process.argv[2];",
								"fs.appendFileSync(log, 'PID=' + process.pid + '\\n');",
								"setTimeout(() => fs.appendFileSync(log, 'JOB_DONE\\n'), Number(process.argv[3]) * 1000);",
							].join("\n"),
						);
						emitToolCall({
							id: `job-${Date.now()}`,
							name: "bash_async",
							arguments: {
								action: "start",
								command: `'${process.execPath}' '${scriptPath}' '${logFile}' ${Number(seconds ?? 2)}`,
								title: "task-poc-job",
								timeout: 300,
							},
						});
					} else if (parsed.verb === "REPORT") {
						const [revision, status] = parsed.args;
						emitToolCall({
							id: `report-${Date.now()}`,
							name: "task_report",
							arguments: {
								revision: Number(revision),
								status: status ?? "success",
								summary: `Fake worker report for revision ${revision}`,
								verification: ["poc fixture"],
							},
						});
					} else if (parsed.verb === "DELEGATE") {
						emitToolCall({ id: `delegate-${Date.now()}`, name: "subagent", arguments: { command: "subagent run" } });
					} else if (parsed.verb === "FAIL") {
						message.stopReason = "error";
						message.errorMessage = "Deliberate non-retryable provider failure";
						stream.push({ type: "error", reason: "error", error: message });
						stream.end();
						return;
					} else if (parsed.verb === "BLOCK") {
						emitText("BLOCKING");
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: "BLOCKING", partial: message });
						await new Promise<void>((resolve) => {
							if (options?.signal?.aborted) resolve();
							else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
						});
						message.stopReason = "aborted";
						stream.push({ type: "error", reason: "aborted", error: message });
						stream.end();
						return;
					} else {
						emitText(`ECHO:${parsed.args.join(" ")}`);
					}
				}
				message.stopReason = reason;
				stream.push({ type: "done", reason, message });
				stream.end();
			})().catch((error: unknown) => {
				message.stopReason = "error";
				stream.push({ type: "error", reason: "error", error: message });
				stream.end();
				mark({ kind: "provider-error", error: String(error) });
			});
			return stream;
		},
	});
}
