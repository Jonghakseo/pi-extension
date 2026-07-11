/** biome-ignore-all lint/suspicious/noExplicitAny: sidecar JSONL entries use dynamic shapes matching existing session format. */
import * as fs from "node:fs";
import type { ClaudeStreamState } from "./claude-stream-parser.js";

export interface SidecarWriter {
	writeUserMessage(task: string): void;
	writeAssistantTurn(state: ClaudeStreamState): void;
	writeToolResult(toolName: string, content: string): void;
	writeFinalAssistant(state: ClaudeStreamState): void;
	writeDone(meta: { exitCode: number; stopReason?: string; runtime?: string }): void;
	readonly filePath: string;
}

function makeEnvelope(role: string, content: any, extra?: Record<string, any>): string {
	const entry: any = {
		type: "message",
		timestamp: Date.now(),
		message: {
			role,
			content,
			timestamp: Date.now(),
			...extra,
		},
	};
	return JSON.stringify(entry);
}

function buildAssistantContent(state: ClaudeStreamState): any[] {
	if (state.messages.length === 0) return [];

	const lastAssistant = [...state.messages].reverse().find((m) => m.role === "assistant");
	if (!lastAssistant) return [];

	const parts: any[] = [];
	for (const part of lastAssistant.content as any[]) {
		if (part.type === "text" && part.text) {
			parts.push({ type: "text", text: part.text });
		} else if (part.type === "thinking" && (part as any).thinking) {
			const thinking = (part as any).thinking as string;
			const preview = thinking.length > 200 ? `${thinking.slice(0, 200)}...` : thinking;
			parts.push({ type: "thinking", thinking: preview });
		} else if (part.type === "toolCall") {
			parts.push({
				type: "toolCall",
				name: (part as any).name ?? "tool",
				arguments: (part as any).arguments ?? {},
			});
		}
	}
	return parts;
}

export function createSidecarWriter(filePath: string): SidecarWriter {
	let lastAssistantTurnIndex = -1;

	function append(line: string): void {
		fs.appendFileSync(filePath, `${line}\n`, "utf-8");
	}

	return {
		get filePath() {
			return filePath;
		},

		writeUserMessage(task: string): void {
			append(makeEnvelope("user", [{ type: "text", text: task }]));
		},

		writeAssistantTurn(state: ClaudeStreamState): void {
			const turnIndex = state.messages.filter((m) => m.role === "assistant").length;
			if (turnIndex <= lastAssistantTurnIndex) return;

			const content = buildAssistantContent(state);
			if (content.length === 0) return;

			lastAssistantTurnIndex = turnIndex;
			append(makeEnvelope("assistant", content));
		},

		writeToolResult(toolName: string, content: string): void {
			append(makeEnvelope("toolResult", [{ type: "text", text: content }], { toolName }));
		},

		writeFinalAssistant(state: ClaudeStreamState): void {
			const turnIndex = state.messages.filter((m) => m.role === "assistant").length;
			if (turnIndex <= lastAssistantTurnIndex) return;

			const content = buildAssistantContent(state);
			if (content.length === 0) return;

			lastAssistantTurnIndex = turnIndex;
			append(makeEnvelope("assistant", content));
		},

		writeDone(meta: { exitCode: number; stopReason?: string; runtime?: string }): void {
			append(
				JSON.stringify({
					type: "subagent_done",
					timestamp: Date.now(),
					exitCode: meta.exitCode,
					stopReason: meta.stopReason,
					runtime: meta.runtime,
				}),
			);
		},
	};
}
