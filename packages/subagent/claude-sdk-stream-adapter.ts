/** biome-ignore-all lint/suspicious/noExplicitAny: SDK messages are intentionally forwarded into the shared Claude event parser. */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	type ClaudeStreamState,
	createStreamState,
	processClaudeEvent,
	stateToSingleResult,
} from "./claude-stream-parser.js";
import type { SingleResult } from "./types.js";

export interface ClaudeSdkStreamAdapter {
	processMessage(message: SDKMessage): boolean;
	getState(): ClaudeStreamState;
	toSingleResult(
		agent: string,
		agentSource: "user" | "project" | "unknown",
		task: string,
		exitCode: number,
		step: number | undefined,
		stderr: string,
	): SingleResult;
}

class ClaudeSdkStreamAdapterImpl implements ClaudeSdkStreamAdapter {
	private readonly state = createStreamState();

	processMessage(message: SDKMessage): boolean {
		return processClaudeEvent(this.state, message as any);
	}

	getState(): ClaudeStreamState {
		return this.state;
	}

	toSingleResult(
		agent: string,
		agentSource: "user" | "project" | "unknown",
		task: string,
		exitCode: number,
		step: number | undefined,
		stderr: string,
	): SingleResult {
		return stateToSingleResult(this.state, agent, agentSource, task, exitCode, step, stderr);
	}
}

export function createClaudeSdkStreamAdapter(): ClaudeSdkStreamAdapter {
	return new ClaudeSdkStreamAdapterImpl();
}
