/** biome-ignore-all lint/suspicious/noExplicitAny: SDK stream payloads and tool bridge results are dynamic runtime data. */
import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "./agents.js";
import { mapThinkingToClaudeEffort } from "./claude-args.js";
import { createClaudeSdkStreamAdapter } from "./claude-sdk-stream-adapter.js";
import { createSidecarWriter } from "./claude-sidecar-writer.js";
import { getFinalOutput } from "./runner.js";
import type { OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";
import { mapPiToolsToClaude, validateClaudeRuntimeModel } from "./utils/agent-utils.js";

function appendStderrDiagnostic(stderr: string, message: string): string {
	const line = `[runner] ${message}`;
	return stderr ? `${stderr.trimEnd()}\n${line}\n` : `${line}\n`;
}

function extractToolNamesFromPrecedingAssistant(messages: SingleResult["messages"]): string[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const names: string[] = [];
		for (const part of message.content as any[]) {
			if (part.type === "toolCall" && typeof part.name === "string") names.push(part.name);
		}
		return names;
	}
	return [];
}

function normalizeTaskForSubagentPrompt(task: string): string {
	if (task.startsWith("/")) return ` \\${task}`;
	return task;
}

function resolveClaudeSdkBuiltInTools(requestedTools?: string[]): string[] | undefined {
	if (!requestedTools || requestedTools.length === 0) return undefined;
	return mapPiToolsToClaude(requestedTools);
}

export async function runClaudeAgentViaSdk(
	defaultCwd: string,
	agent: AgentConfig,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	resumeSessionId?: string,
	sidecarSessionFile?: string,
): Promise<SingleResult> {
	try {
		validateClaudeRuntimeModel(agent.model);
	} catch (error: any) {
		return {
			agent: agent.name,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: error.message,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			runtime: "claude",
			step,
		};
	}

	const adapter = createClaudeSdkStreamAdapter();
	const sidecar = sidecarSessionFile ? createSidecarWriter(sidecarSessionFile) : null;
	const abortController = new AbortController();
	let stderrBuf = "";
	let completionMarkerWritten = false;
	let sidecarInitialUserWritten = false;
	let externalAbortRequested = false;
	let sdkFailed = false;

	let enabledTools: string[] | undefined;
	try {
		enabledTools = resolveClaudeSdkBuiltInTools(agent.tools);
	} catch (error: any) {
		return {
			agent: agent.name,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: error.message,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			runtime: "claude",
			step,
		};
	}

	const model = agent.model?.replace(/^anthropic\//, "");
	const effort = agent.thinking ? mapThinkingToClaudeEffort(agent.thinking) : undefined;

	const emitUpdate = () => {
		if (!onUpdate) return;
		const state = adapter.getState();
		const text = state.liveText ?? getFinalOutput(state.messages) ?? "(running...)";
		const partial = adapter.toSingleResult(agent.name, agent.source, task, 0, step, stderrBuf);
		partial.liveText = state.liveText;
		partial.liveThinking = state.liveThinking;
		partial.liveToolCalls = state.liveToolCalls;
		partial.thoughtText = state.thoughtText;
		onUpdate({
			content: [{ type: "text", text }],
			details: makeDetails([partial]),
		});
	};

	const writeCompletionMarkerOnce = (exitCode: number, stopReason?: string) => {
		if (!sidecar || completionMarkerWritten) return;
		completionMarkerWritten = true;
		sidecar.writeDone({ exitCode, stopReason, runtime: "claude" });
	};

	const forwardAbort = () => {
		externalAbortRequested = true;
		abortController.abort(signal?.reason);
	};

	if (signal?.aborted) {
		forwardAbort();
		writeCompletionMarkerOnce(1, "aborted");
		throw new Error("Subagent was aborted");
	}
	signal?.addEventListener("abort", forwardAbort, { once: true });

	let sdkQuery: ReturnType<typeof query>;
	try {
		sdkQuery = query({
			prompt: normalizeTaskForSubagentPrompt(task),
			options: {
				abortController,
				cwd: defaultCwd,
				model,
				effort,
				systemPrompt: agent.systemPrompt.trim() || undefined,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				settingSources: [],
				includePartialMessages: true,
				persistSession: true,
				...(enabledTools ? { tools: enabledTools, allowedTools: enabledTools } : {}),
				resume: resumeSessionId,
				stderr: (data) => {
					stderrBuf += data;
				},
			},
		});
	} catch (error) {
		if (externalAbortRequested) {
			writeCompletionMarkerOnce(1, "aborted");
			throw new Error("Subagent was aborted");
		}
		sdkFailed = true;
		stderrBuf = appendStderrDiagnostic(
			stderrBuf,
			`claude-sdk error: ${error instanceof Error ? error.message : String(error)}`,
		);
		const result = adapter.toSingleResult(agent.name, agent.source, task, 1, step, stderrBuf);
		result.sessionFile = sidecarSessionFile;
		result.claudeProjectDir = defaultCwd;
		return result;
	}

	try {
		for await (const message of sdkQuery) {
			if (sidecar && !sidecarInitialUserWritten) {
				sidecarInitialUserWritten = true;
				sidecar.writeUserMessage(task);
			}

			const state = adapter.getState();
			const messageCountBefore = state.messages.length;
			const isResult = adapter.processMessage(message);
			emitUpdate();

			if (sidecar && state.messages.length > messageCountBefore) {
				for (let index = messageCountBefore; index < state.messages.length; index++) {
					const addedMessage = state.messages[index];
					if (addedMessage.role === "assistant") {
						sidecar.writeAssistantTurn(state);
					} else if (addedMessage.role === "user") {
						const toolNames = extractToolNamesFromPrecedingAssistant(state.messages);
						const textParts = (addedMessage.content as any[])
							.filter((part: any) => part.type === "text" && part.text)
							.map((part: any) => part.text);
						const content = textParts.join("\n") || "(no output)";
						sidecar.writeToolResult(toolNames[0] ?? "tool", content);
					}
				}
			}

			if (isResult) {
				if (sidecar) sidecar.writeFinalAssistant(state);
				writeCompletionMarkerOnce(state.isError ? 1 : 0, state.stopReason);
			}
		}
	} catch (error) {
		if (!externalAbortRequested && (!(error instanceof AbortError) || !abortController.signal.aborted)) {
			sdkFailed = true;
			stderrBuf = appendStderrDiagnostic(
				stderrBuf,
				`claude-sdk error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} finally {
		sdkQuery.close();
	}

	if (externalAbortRequested) {
		writeCompletionMarkerOnce(1, "aborted");
		throw new Error("Subagent was aborted");
	}

	const state = adapter.getState();
	const finalExitCode = sdkFailed || state.isError ? 1 : 0;
	writeCompletionMarkerOnce(finalExitCode, state.stopReason);
	const result = adapter.toSingleResult(agent.name, agent.source, task, finalExitCode, step, stderrBuf);
	result.sessionFile = sidecarSessionFile;
	result.claudeProjectDir = defaultCwd;
	return result;
}
