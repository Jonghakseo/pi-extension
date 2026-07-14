/** biome-ignore-all lint/suspicious/noExplicitAny: subprocess event stream and provider payloads are dynamic runtime data. */
/**
 * Subagent process execution and result processing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.js";
import { buildClaudeArgs } from "./claude-args.js";
import { createSidecarWriter } from "./claude-sidecar-writer.js";
import {
	type ClaudeStreamState,
	createStreamState,
	processClaudeEvent,
	stateToSingleResult,
} from "./claude-stream-parser.js";
import { resolveClaudeRuntimeMode } from "./config.js";
import { CONTEXT_GUARD_SIGNATURE, resolveContextGuardCeiling, shouldTripContextGuard } from "./context-limits.js";
import {
	emitRunnerDiagnostic,
	type RunnerDiagnosticSink,
	readProcessIdentity,
	serializeDiagnosticValue,
	toDiagnosticError,
} from "./diagnostics.js";
import { formatToolCallPlain } from "./format.js";
import {
	extractActivityPreviewFromTextDelta,
	extractThoughtText,
	formatPiToolExecutionPreview,
} from "./live-preview.js";
import { appendCompletionMarker, readPersistedSessionSnapshot } from "./persisted-session.js";
import { writePromptToTempFile } from "./session.js";
import type { AgentAliasMatch, DisplayItem, OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";
import {
	computeAgentAliasHints as computeAgentAliasHintsUtil,
	getSubCommandAgentCompletions as getSubCommandAgentCompletionsUtil,
	mapPiToolsToClaude,
	matchSubCommandAgent as matchSubCommandAgentUtil,
	validateClaudeRuntimeModel,
} from "./utils/agent-utils.js";

export interface RunSingleAgentSessionConfig {
	sessionFile?: string;
	resumeSessionId?: string;
	sidecarSessionFile?: string;
	persistedSessionBaseOffset?: number;
	onDiagnostic?: RunnerDiagnosticSink;
}

function isUuidLikeSessionId(value: string | undefined): boolean {
	return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function normalizeRunSessionConfig(config?: string | RunSingleAgentSessionConfig): RunSingleAgentSessionConfig {
	if (!config) return {};
	if (typeof config !== "string") return config;
	if (isUuidLikeSessionId(config)) return { resumeSessionId: config };
	return { sessionFile: config, sidecarSessionFile: config };
}

function extractToolNamesFromPrecedingAssistant(state: ClaudeStreamState): string[] {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const msg = state.messages[i];
		if (msg.role === "assistant") {
			const names: string[] = [];
			for (const part of msg.content as any[]) {
				if (part.type === "toolCall" && typeof part.name === "string") {
					names.push(part.name);
				}
			}
			return names;
		}
	}
	return [];
}

function appendStderrDiagnostic(result: SingleResult, message: string): void {
	const line = `[runner] ${message}`;
	result.stderr = result.stderr ? `${result.stderr.trimEnd()}\n${line}\n` : `${line}\n`;
}

/**
 * Prevent tasks starting with `/` from being treated as slash commands
 * inside the spawned pi process.
 *
 * We prepend one space (requested behavior) and escape the slash, so
 * trim()-based slash command interceptors won't swallow the task.
 */
function normalizeTaskForSubagentPrompt(task: string): string {
	if (task.startsWith("/")) return ` \\${task}`;
	return task;
}

// ─── Result Helpers ──────────────────────────────────────────────────────────

export function getLastNonEmptyLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.pop() ?? ""
	);
}

export function getFinalOutput(messages: Message[]): string {
	// First pass: prefer text blocks
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text) return part.text;
			}
		}
	}
	// Second pass: fall back to thinking blocks (extended thinking models may emit
	// only a thinking block with no text block on the final turn)
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "thinking" && part.thinking) return part.thinking;
			}
		}
	}
	return "";
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

export function getLatestActivityPreview(messages: Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Message & { toolName?: string };
		if (msg.role === "toolResult") {
			const text = (msg.content as Array<{ type?: string; text?: string }>)
				.filter((part) => part.type === "text" && part.text)
				.map((part) => part.text ?? "")
				.join("\n");
			const line = getLastNonEmptyLine(text);
			if (!line) continue;
			const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
			return toolName ? `← ${toolName}: ${line}` : line;
		}
		if (msg.role === "assistant") {
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const part = msg.content[j];
				if (part.type === "toolCall") return `→ ${formatToolCallPlain(part.name, part.arguments)}`;
				if (part.type === "text") {
					const line = getLastNonEmptyLine(part.text);
					if (line) return line;
				}
			}
		}
	}
	return undefined;
}

// ─── Agent Matching ──────────────────────────────────────────────────────────

export function matchSubCommandAgent(agents: AgentConfig[], token: string): AgentAliasMatch {
	return matchSubCommandAgentUtil(agents, token);
}

export function getSubCommandAgentCompletions(
	agents: AgentConfig[],
	argumentPrefix: string,
): { value: string; label: string; description?: string }[] | null {
	return getSubCommandAgentCompletionsUtil(agents, argumentPrefix);
}

/**
 * Compute shortest usable alias for each agent and return a formatted hint string.
 * e.g. "w→worker  s→searcher  r→reviewer  v→verifier"
 */
export function computeAgentAliasHints(agents: AgentConfig[]): string {
	return computeAgentAliasHintsUtil(agents);
}

// ─── Single Agent Execution ──────────────────────────────────────────────────

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	sessionConfig?: string | RunSingleAgentSessionConfig,
): Promise<SingleResult> {
	const normalizedSessionConfig = normalizeRunSessionConfig(sessionConfig);
	const sessionFile = normalizedSessionConfig.sessionFile;
	const resumeSessionId = normalizedSessionConfig.resumeSessionId;
	const sidecarSessionFile = normalizedSessionConfig.sidecarSessionFile ?? sessionFile;
	const persistedSessionBaseOffset = normalizedSessionConfig.persistedSessionBaseOffset ?? 0;
	const onDiagnostic = normalizedSessionConfig.onDiagnostic;
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	if (agent.runtime === "claude") {
		if (resolveClaudeRuntimeMode(defaultCwd) === "sdk") {
			const { runClaudeAgentViaSdk } = await import("./claude-sdk-runner.js");
			return runClaudeAgentViaSdk(
				defaultCwd,
				agent,
				task,
				step,
				signal,
				onUpdate,
				makeDetails,
				resumeSessionId,
				sidecarSessionFile,
			);
		}
		return runClaudeAgent(
			defaultCwd,
			agent,
			task,
			step,
			signal,
			onUpdate,
			makeDetails,
			resumeSessionId,
			sidecarSessionFile,
			onDiagnostic,
		);
	}

	return runPiAgent(
		defaultCwd,
		agent,
		agentName,
		task,
		step,
		signal,
		onUpdate,
		makeDetails,
		sessionFile,
		persistedSessionBaseOffset,
		onDiagnostic,
	);
}

async function runClaudeAgent(
	defaultCwd: string,
	agent: AgentConfig,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	resumeSessionId?: string,
	sidecarSessionFile?: string,
	onDiagnostic?: RunnerDiagnosticSink,
): Promise<SingleResult> {
	try {
		validateClaudeRuntimeModel(agent.model);
	} catch (err: any) {
		return {
			agent: agent.name,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: err.message,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			runtime: "claude",
			step,
		};
	}

	if (agent.tools && agent.tools.length > 0) {
		try {
			mapPiToolsToClaude(agent.tools);
		} catch (err: any) {
			return {
				agent: agent.name,
				agentSource: agent.source,
				task,
				exitCode: 1,
				messages: [],
				stderr: err.message,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				runtime: "claude",
				step,
			};
		}
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const resumeId = resumeSessionId;
	const sidecarPath = sidecarSessionFile;

	const streamState = createStreamState();
	let stderrBuf = "";
	const sidecar = sidecarPath ? createSidecarWriter(sidecarPath) : null;
	let sidecarInitialUserWritten = false;
	let completionMarkerWritten = false;
	let wasAborted = false;

	const diagnose = (event: Parameters<RunnerDiagnosticSink>[0]) => {
		emitRunnerDiagnostic(onDiagnostic, { runtime: "claude", ...event });
	};

	const emitUpdate = () => {
		if (!onUpdate) return;
		const text = streamState.liveText ?? getFinalOutput(streamState.messages) ?? "(running...)";
		const partial = stateToSingleResult(streamState, agent.name, agent.source, task, 0, step, stderrBuf);
		partial.liveText = streamState.liveText;
		partial.liveThinking = streamState.liveThinking;
		partial.liveToolCalls = streamState.liveToolCalls;
		partial.thoughtText = streamState.thoughtText;
		onUpdate({
			content: [{ type: "text", text }],
			details: makeDetails([partial]),
		});
	};

	const writeCompletionMarkerOnce = (exitCode: number) => {
		if (!sidecar || completionMarkerWritten) return;
		completionMarkerWritten = true;
		const stopReason = wasAborted ? "aborted" : streamState.stopReason;
		const normalizedExitCode = stopReason === "error" || stopReason === "aborted" ? 1 : exitCode;
		sidecar.writeDone({ exitCode: normalizedExitCode, stopReason, runtime: "claude" });
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
		}

		const args = buildClaudeArgs({
			prompt: normalizeTaskForSubagentPrompt(task),
			tools: agent.tools ?? [],
			model: agent.model,
			thinking: agent.thinking,
			resumeSessionId: resumeId,
			cwd: defaultCwd,
			systemPromptFile: tmpPromptPath ?? undefined,
		});

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("claude", args, { cwd: defaultCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";
			let procExited = false;
			let settled = false;
			let exitFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let resultLingerTimer: ReturnType<typeof setTimeout> | undefined;
			let lastExitCode = 0;
			let lastProcessSignal: NodeJS.Signals | null = null;
			let settleReason = "unknown";
			let unparsedStdoutCount = 0;
			const unparsedStdoutTail: string[] = [];
			const parentIdentity = onDiagnostic ? readProcessIdentity(process.pid) : undefined;
			const childIdentity = onDiagnostic ? readProcessIdentity(proc.pid) : undefined;

			diagnose({
				event: "spawn",
				parentPid: process.pid,
				parentProcessGroupId: parentIdentity?.processGroupId,
				childPid: proc.pid,
				childParentPid: childIdentity?.parentPid,
				childProcessGroupId: childIdentity?.processGroupId,
				processGroupMode: "inherited",
			});

			const terminateProcess = (terminationSignal: NodeJS.Signals, cause: string): boolean => {
				diagnose({
					event: "kill_intent",
					childPid: proc.pid,
					signal: terminationSignal,
					cause,
					stopReason: streamState.stopReason,
				});
				try {
					const killSent = proc.kill(terminationSignal);
					diagnose({
						event: "kill_result",
						childPid: proc.pid,
						signal: terminationSignal,
						cause,
						killSent,
					});
					return killSent;
				} catch (error) {
					diagnose({
						event: "process_error",
						childPid: proc.pid,
						cause: `kill:${cause}`,
						error: toDiagnosticError(error),
					});
					return false;
				}
			};

			const scheduleKillEscalation = (cause: string) => {
				setTimeout(() => {
					if (!procExited && proc.exitCode === null) terminateProcess("SIGKILL", `${cause}:grace_timeout`);
				}, 5000);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					unparsedStdoutCount++;
					const snippet = line.trim().slice(0, 300);
					if (snippet) {
						unparsedStdoutTail.push(snippet);
						if (unparsedStdoutTail.length > 3) unparsedStdoutTail.shift();
					}
					return;
				}
				if (sidecar && !sidecarInitialUserWritten) {
					sidecarInitialUserWritten = true;
					sidecar.writeUserMessage(task);
				}

				const msgCountBefore = streamState.messages.length;
				const isResult = processClaudeEvent(streamState, event);
				emitUpdate();

				if (sidecar && streamState.messages.length > msgCountBefore) {
					for (let i = msgCountBefore; i < streamState.messages.length; i++) {
						const msg = streamState.messages[i];
						if (msg.role === "assistant") {
							sidecar.writeAssistantTurn(streamState);
						} else if (msg.role === "user") {
							const toolNames = extractToolNamesFromPrecedingAssistant(streamState);
							const textParts = (msg.content as any[])
								.filter((p: any) => p.type === "text" && p.text)
								.map((p: any) => p.text);
							const content = textParts.join("\n") || "(no output)";
							sidecar.writeToolResult(toolNames[0] ?? "tool", content);
						}
					}
				}

				if (isResult) {
					if (sidecar) sidecar.writeFinalAssistant(streamState);
					writeCompletionMarkerOnce(streamState.isError ? 1 : 0);
					schedulePostResultLinger();
				}
			};

			const resolveOnce = (code: number) => {
				if (settled) return;
				settled = true;
				if (buffer.trim()) {
					const pendingLine = buffer;
					buffer = "";
					processLine(pendingLine);
				}
				const finalCode = streamState.isError || streamState.stopReason === "error" ? 1 : code;
				writeCompletionMarkerOnce(finalCode);
				if (exitFallbackTimer) {
					clearTimeout(exitFallbackTimer);
					exitFallbackTimer = undefined;
				}
				if (resultLingerTimer) {
					clearTimeout(resultLingerTimer);
					resultLingerTimer = undefined;
				}

				if (streamState.messages.length === 0) {
					const msg = `no assistant/tool messages captured; settleReason=${settleReason}; exitCode=${finalCode}; resultReceived=${streamState.resultReceived}`;
					appendStderrDiagnostic({ stderr: stderrBuf } as SingleResult, msg);
					stderrBuf += `[runner] ${msg}\n`;
					if (unparsedStdoutCount > 0) {
						const tail = `unparsed stdout lines=${unparsedStdoutCount}; tail=${unparsedStdoutTail.join(" | ") || "(empty)"}`;
						stderrBuf += `[runner] ${tail}\n`;
					}
				}
				diagnose({
					event: "settled",
					childPid: proc.pid,
					code: finalCode,
					signal: lastProcessSignal,
					settleReason,
					stopReason: wasAborted ? "aborted" : streamState.stopReason,
				});
				resolve(finalCode);
			};

			function schedulePostResultLinger() {
				if (settled || procExited) {
					settleReason = "result_immediate";
					resolveOnce(0);
					return;
				}
				if (resultLingerTimer) clearTimeout(resultLingerTimer);
				resultLingerTimer = setTimeout(() => {
					if (settled || procExited) return;
					terminateProcess("SIGTERM", "result_linger_timeout");
					scheduleKillEscalation("result_linger_timeout");
					settleReason = "result_linger_timeout";
					resolveOnce(0);
				}, 3000);
			}

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				stderrBuf += data.toString();
			});

			proc.on("exit", (code, terminationSignal) => {
				procExited = true;
				lastExitCode = code ?? 0;
				lastProcessSignal = terminationSignal;
				diagnose({ event: "exit", childPid: proc.pid, code, signal: terminationSignal });
				if (streamState.resultReceived) {
					settleReason = "exit_after_result";
					resolveOnce(0);
					return;
				}
				exitFallbackTimer = setTimeout(() => {
					settleReason = "exit_fallback_timeout";
					resolveOnce(lastExitCode);
				}, 1500);
			});

			proc.on("close", (code, terminationSignal) => {
				procExited = true;
				lastProcessSignal = terminationSignal ?? lastProcessSignal;
				diagnose({ event: "close", childPid: proc.pid, code, signal: terminationSignal });
				if (!settled) {
					settleReason = "close";
					resolveOnce(streamState.resultReceived ? 0 : (code ?? lastExitCode ?? 0));
				}
			});

			proc.on("error", (error) => {
				procExited = true;
				stderrBuf += `[runner] process error: ${error?.message || String(error)}\n`;
				diagnose({
					event: "process_error",
					childPid: proc.pid,
					cause: "child_process_event",
					error: toDiagnosticError(error),
				});
				settleReason = "process_error";
				resolveOnce(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					settleReason = "aborted_by_signal";
					diagnose({
						event: "abort_received",
						childPid: proc.pid,
						abortReason: serializeDiagnosticValue(signal.reason),
					});
					terminateProcess("SIGTERM", "abort_signal");
					scheduleKillEscalation("abort_signal");
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		if (wasAborted) throw new Error("Subagent was aborted");

		const finalExitCode = streamState.isError ? 1 : exitCode;
		const result = stateToSingleResult(streamState, agent.name, agent.source, task, finalExitCode, step, stderrBuf);
		result.sessionFile = sidecarPath;
		result.claudeProjectDir = defaultCwd;
		return result;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

async function runPiAgent(
	defaultCwd: string,
	agent: AgentConfig,
	agentName: string,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	sessionFile?: string,
	persistedSessionBaseOffset = 0,
	onDiagnostic?: RunnerDiagnosticSink,
): Promise<SingleResult> {
	const args: string[] = ["--mode", "json", "-p"];
	if (sessionFile) args.push("--session", sessionFile);
	else args.push("--no-session");
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
		sessionFile,
	};
	let completionMarkerWritten = false;
	let wasAborted = false;
	const contextGuardCeiling = resolveContextGuardCeiling(agent.model, "pi");
	let contextGuardTripped = false;
	let peakContextTokens = 0;

	const diagnose = (event: Parameters<RunnerDiagnosticSink>[0]) => {
		emitRunnerDiagnostic(onDiagnostic, { runtime: "pi", ...event });
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{ type: "text", text: getFinalOutput(currentResult.messages) || currentResult.liveText || "(running...)" },
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	const writeCompletionMarkerOnce = (exitCode: number) => {
		if (!sessionFile || completionMarkerWritten) return;
		completionMarkerWritten = true;
		const stopReason = wasAborted ? "aborted" : currentResult.stopReason;
		const normalizedExitCode = stopReason === "error" || stopReason === "aborted" ? 1 : exitCode;
		appendCompletionMarker(sessionFile, { exitCode: normalizedExitCode, stopReason, runtime: "pi" });
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(normalizeTaskForSubagentPrompt(task));

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd: defaultCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";
			let procExited = false;
			let settled = false;
			let exitFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let agentEndFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let terminalMessageFallbackTimer: ReturnType<typeof setTimeout> | undefined;
			let sessionPollTimer: ReturnType<typeof setInterval> | undefined;
			let lastExitCode = 0;
			let lastProcessSignal: NodeJS.Signals | null = null;
			let lastEventAt = Date.now();
			let sawAgentEnd = false;
			let settleReason = "unknown";
			let unparsedStdoutCount = 0;
			const unparsedStdoutTail: string[] = [];
			const parentIdentity = onDiagnostic ? readProcessIdentity(process.pid) : undefined;
			const childIdentity = onDiagnostic ? readProcessIdentity(proc.pid) : undefined;

			diagnose({
				event: "spawn",
				parentPid: process.pid,
				parentProcessGroupId: parentIdentity?.processGroupId,
				childPid: proc.pid,
				childParentPid: childIdentity?.parentPid,
				childProcessGroupId: childIdentity?.processGroupId,
				processGroupMode: "inherited",
			});

			const terminateProcess = (terminationSignal: NodeJS.Signals, cause: string): boolean => {
				diagnose({
					event: "kill_intent",
					childPid: proc.pid,
					signal: terminationSignal,
					cause,
					stopReason: currentResult.stopReason,
				});
				try {
					const killSent = proc.kill(terminationSignal);
					diagnose({
						event: "kill_result",
						childPid: proc.pid,
						signal: terminationSignal,
						cause,
						killSent,
					});
					return killSent;
				} catch (error) {
					diagnose({
						event: "process_error",
						childPid: proc.pid,
						cause: `kill:${cause}`,
						error: toDiagnosticError(error),
					});
					return false;
				}
			};

			const scheduleKillEscalation = (cause: string) => {
				setTimeout(() => {
					if (!procExited && proc.exitCode === null) terminateProcess("SIGKILL", `${cause}:grace_timeout`);
				}, 5000);
			};

			const syncFromPersistedSession = (allowResolve: boolean): boolean => {
				if (!sessionFile) return false;
				const snapshot = readPersistedSessionSnapshot(sessionFile, { startOffset: persistedSessionBaseOffset });
				if (snapshot.terminalStopReason && !currentResult.stopReason) {
					currentResult.stopReason = snapshot.terminalStopReason;
				}
				if (snapshot.messages.length > currentResult.messages.length) {
					currentResult.messages = snapshot.messages;
					currentResult.liveText = undefined;
					emitUpdate();
				}
				if (!allowResolve || !snapshot.isTerminal || settled || procExited || wasAborted) return false;

				const forcedCode =
					snapshot.completionMarker?.exitCode ??
					(snapshot.terminalStopReason === "error" || snapshot.terminalStopReason === "aborted" ? 1 : 0);
				writeCompletionMarkerOnce(forcedCode);
				const fallbackReason = snapshot.completionMarker
					? "session_done_marker_fallback"
					: "session_terminal_message_fallback";
				terminateProcess("SIGTERM", fallbackReason);
				scheduleKillEscalation(fallbackReason);
				settleReason = fallbackReason;
				resolveOnce(forcedCode);
				return true;
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					unparsedStdoutCount++;
					const snippet = line.trim().slice(0, 300);
					if (snippet) {
						unparsedStdoutTail.push(snippet);
						if (unparsedStdoutTail.length > 3) unparsedStdoutTail.shift();
					}
					return;
				}
				lastEventAt = Date.now();

				if (event.type === "agent_start" || event.type === "turn_start") {
					sawAgentEnd = false;
					currentResult.liveThinking = undefined;
					currentResult.thoughtText = undefined;
					if (terminalMessageFallbackTimer) {
						clearTimeout(terminalMessageFallbackTimer);
						terminalMessageFallbackTimer = undefined;
					}
					return;
				}

				if (event.type === "agent_end") {
					// Error paths may emit agent_end without message_end. Recover only the
					// final terminal message: agent_end contains the whole conversation and
					// its objects are freshly deserialized, so reference-based deduplication
					// would append every prior message again.
					const eventMessages = (event.messages ?? []) as Message[];
					const terminalMessage = [...eventMessages].reverse().find((msg) => Boolean((msg as any).stopReason));
					if (terminalMessage) {
						const fingerprint = JSON.stringify(terminalMessage);
						const alreadyCaptured = currentResult.messages.some((msg) => JSON.stringify(msg) === fingerprint);
						if (!alreadyCaptured) currentResult.messages.push(terminalMessage);
						if (!currentResult.stopReason) {
							currentResult.stopReason = (terminalMessage as any).stopReason;
							if ((terminalMessage as any).errorMessage) {
								currentResult.errorMessage = (terminalMessage as any).errorMessage;
							}
						}
					} else if (currentResult.messages.length === 0 && eventMessages.length > 0) {
						currentResult.messages.push(eventMessages[eventMessages.length - 1]);
					}
					if (currentResult.stopReason && currentResult.stopReason !== "toolUse") {
						writeCompletionMarkerOnce(
							currentResult.stopReason === "error" || currentResult.stopReason === "aborted" ? 1 : 0,
						);
					}
					sawAgentEnd = true;
					scheduleAgentEndForceResolve();
					return;
				}

				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (delta?.type === "text_delta") {
						const chunk = typeof delta.delta === "string" ? delta.delta : "";
						if (chunk) {
							currentResult.liveText = `${currentResult.liveText ?? ""}${chunk}`;
							const preview = extractActivityPreviewFromTextDelta(currentResult.liveText);
							if (preview) currentResult.liveActivityPreview = preview;
							emitUpdate();
						}
						return;
					}
					if (delta?.type === "thinking_delta") {
						const chunk = typeof delta.delta === "string" ? delta.delta : "";
						if (chunk) {
							currentResult.liveThinking = `${currentResult.liveThinking ?? ""}${chunk}`;
							const thoughtText = extractThoughtText(currentResult.liveThinking);
							if (thoughtText) currentResult.thoughtText = thoughtText;
							emitUpdate();
						}
						return;
					}
					return;
				}

				if (event.type === "tool_execution_start") {
					currentResult.liveToolCalls = (currentResult.liveToolCalls ?? 0) + 1;
					if (typeof event.toolName === "string") {
						currentResult.liveActivityPreview = formatPiToolExecutionPreview(event.toolName, event.args);
					}
					emitUpdate();
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.liveText = undefined;
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						peakContextTokens = Math.max(peakContextTokens, currentResult.usage.contextTokens);
						// ④ Proactive context guard: stop just below the provider's real
						// ceiling so heavy runs surface partial findings instead of a raw
						// context-overflow error one turn later.
						if (
							shouldTripContextGuard({
								stopReason: msg.stopReason,
								peakContextTokens,
								ceiling: contextGuardCeiling,
								alreadyTripped: contextGuardTripped,
							}) &&
							!settled &&
							!procExited &&
							!wasAborted
						) {
							contextGuardTripped = true;
							currentResult.stopReason = "error";
							currentResult.errorMessage =
								`${CONTEXT_GUARD_SIGNATURE} stopped at ${peakContextTokens} tokens ` +
								`(ceiling ${contextGuardCeiling}) to preserve partial findings before provider context overflow.`;
							terminateProcess("SIGTERM", "context_guard");
							scheduleKillEscalation("context_guard");
							settleReason = "context_guard";
							resolveOnce(1);
							return;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						currentResult.liveThinking = undefined;

						// Extract thoughtText from thinking block first line only
						for (const part of msg.content) {
							if (part.type === "thinking") {
								const raw = typeof (part as any).thinking === "string" ? (part as any).thinking : "";
								const thoughtText = extractThoughtText(raw);
								if (thoughtText) currentResult.thoughtText = thoughtText;
							}
						}
						const terminalStopReason = (msg as any).stopReason;
						if (terminalStopReason && terminalStopReason !== "toolUse") {
							writeCompletionMarkerOnce(terminalStopReason === "error" || terminalStopReason === "aborted" ? 1 : 0);
							scheduleTerminalMessageForceResolve();
						}
					}
					emitUpdate();
					if (sawAgentEnd) scheduleAgentEndForceResolve();
					return;
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
					if (sawAgentEnd) scheduleAgentEndForceResolve();
					return;
				}

				if (sawAgentEnd) scheduleAgentEndForceResolve();
			};

			const resolveOnce = (code: number) => {
				if (settled) return;
				settled = true;
				if (buffer.trim()) {
					const pendingLine = buffer;
					buffer = "";
					processLine(pendingLine);
				}
				syncFromPersistedSession(false);
				const finalCode = currentResult.stopReason === "error" || currentResult.stopReason === "aborted" ? 1 : code;
				writeCompletionMarkerOnce(finalCode);
				if (exitFallbackTimer) {
					clearTimeout(exitFallbackTimer);
					exitFallbackTimer = undefined;
				}
				if (agentEndFallbackTimer) {
					clearTimeout(agentEndFallbackTimer);
					agentEndFallbackTimer = undefined;
				}
				if (terminalMessageFallbackTimer) {
					clearTimeout(terminalMessageFallbackTimer);
					terminalMessageFallbackTimer = undefined;
				}
				if (sessionPollTimer) {
					clearInterval(sessionPollTimer);
					sessionPollTimer = undefined;
				}

				if (currentResult.messages.length === 0) {
					appendStderrDiagnostic(
						currentResult,
						`no assistant/tool messages captured; settleReason=${settleReason}; exitCode=${finalCode}; sawAgentEnd=${sawAgentEnd}`,
					);
					if (unparsedStdoutCount > 0) {
						appendStderrDiagnostic(
							currentResult,
							`unparsed stdout lines=${unparsedStdoutCount}; tail=${unparsedStdoutTail.join(" | ") || "(empty)"}`,
						);
					}
				}
				diagnose({
					event: "settled",
					childPid: proc.pid,
					code: finalCode,
					signal: lastProcessSignal,
					settleReason,
					stopReason: wasAborted ? "aborted" : currentResult.stopReason,
				});
				resolve(finalCode);
			};

			function scheduleTerminalMessageForceResolve() {
				if (!currentResult.stopReason || currentResult.stopReason === "toolUse" || settled || procExited) return;
				if (terminalMessageFallbackTimer) clearTimeout(terminalMessageFallbackTimer);

				terminalMessageFallbackTimer = setTimeout(() => {
					if (settled || procExited || wasAborted) return;

					const forcedCode = currentResult.stopReason === "error" || currentResult.stopReason === "aborted" ? 1 : 0;

					terminateProcess("SIGTERM", "terminal_message_fallback_timeout");
					scheduleKillEscalation("terminal_message_fallback_timeout");

					settleReason = "terminal_message_fallback_timeout";
					resolveOnce(forcedCode);
				}, 3000);
			}

			// print-mode sometimes keeps the Node process alive after agent_end
			// (e.g. lingering extension timers/transports). In that case, force
			// resolve after a short quiet period so runs do not remain "running" forever.
			function scheduleAgentEndForceResolve() {
				if (!sawAgentEnd || settled || procExited) return;
				if (agentEndFallbackTimer) clearTimeout(agentEndFallbackTimer);

				const marker = lastEventAt;
				agentEndFallbackTimer = setTimeout(() => {
					if (settled || procExited || wasAborted) return;
					if (lastEventAt !== marker) return;

					const forcedCode = currentResult.stopReason === "error" || currentResult.stopReason === "aborted" ? 1 : 0;

					terminateProcess("SIGTERM", "agent_end_fallback_timeout");
					scheduleKillEscalation("agent_end_fallback_timeout");

					settleReason = "agent_end_fallback_timeout";
					resolveOnce(forcedCode);
				}, 1500);
			}

			if (sessionFile) {
				sessionPollTimer = setInterval(() => {
					syncFromPersistedSession(true);
				}, 1000);
			}

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("exit", (code, terminationSignal) => {
				procExited = true;
				lastExitCode = code ?? 0;
				lastProcessSignal = terminationSignal;
				diagnose({ event: "exit", childPid: proc.pid, code, signal: terminationSignal });
				// In rare cases stdout/stderr pipes may stay open after process exit.
				// Use a short fallback so runs cannot stay "running" forever.
				exitFallbackTimer = setTimeout(() => {
					settleReason = "exit_fallback_timeout";
					resolveOnce(lastExitCode);
				}, 1500);
			});

			proc.on("close", (code, terminationSignal) => {
				procExited = true;
				lastProcessSignal = terminationSignal ?? lastProcessSignal;
				diagnose({ event: "close", childPid: proc.pid, code, signal: terminationSignal });
				settleReason = "close";
				resolveOnce(code ?? lastExitCode ?? 0);
			});

			proc.on("error", (error) => {
				procExited = true;
				appendStderrDiagnostic(currentResult, `process error: ${error?.message || String(error)}`);
				diagnose({
					event: "process_error",
					childPid: proc.pid,
					cause: "child_process_event",
					error: toDiagnosticError(error),
				});
				settleReason = "process_error";
				resolveOnce(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					settleReason = "aborted_by_signal";
					diagnose({
						event: "abort_received",
						childPid: proc.pid,
						abortReason: serializeDiagnosticValue(signal.reason),
					});
					terminateProcess("SIGTERM", "abort_signal");
					scheduleKillEscalation("abort_signal");
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}
