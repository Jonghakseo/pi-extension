import { describe, expect, it } from "vitest";
import { applyCompressionResult, buildCompressionPayload } from "./bridge.ts";
import type { AgentMessage, OpenAIMessage } from "./types.ts";

function createAssistantMessage(): AgentMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_1",
				name: "list_records",
				arguments: { limit: 1000 },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: zeroCost() },
		stopReason: "toolUse",
		timestamp: 1,
	} as AgentMessage;
}

function createToolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "list_records",
		content: [{ type: "text", text }],
		details: { rows: 1000 },
		isError: false,
		timestamp: 2,
	} as AgentMessage;
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage;
}

function zeroCost() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

describe("headroom bridge", () => {
	it("applies compressed toolResult text while preserving Pi metadata", () => {
		const originalText = JSON.stringify(Array.from({ length: 10 }, (_, id) => ({ id, status: "ok" })));
		const messages = [createUserMessage("summarize records"), createAssistantMessage(), createToolResult(originalText)];
		const payload = buildCompressionPayload(messages, 10);
		const compressed = payload.messages.map((message): OpenAIMessage => {
			if (message.role === "tool") {
				return { ...message, content: "[10 records compressed to 2 representative rows]" };
			}
			return message;
		});

		const result = applyCompressionResult(messages, payload.mappings, compressed, { minMessageChars: 10 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const toolResult = result.messages[2] as Extract<AgentMessage, { role: "toolResult" }>;
		expect(toolResult.toolName).toBe("list_records");
		expect(toolResult.details).toEqual({ rows: 1000 });
		expect(toolResult.content).toEqual([{ type: "text", text: "[10 records compressed to 2 representative rows]" }]);
	});

	it("rejects compression when message count changes", () => {
		const messages = [createUserMessage("go"), createAssistantMessage(), createToolResult("large result")];
		const payload = buildCompressionPayload(messages, 5);

		const result = applyCompressionResult(messages, payload.mappings, payload.messages.slice(1), {
			minMessageChars: 5,
		});

		expect(result).toEqual({ ok: false, reason: "message-count-changed" });
	});

	it("rejects compression when non-candidate user content changes", () => {
		const messages = [
			createUserMessage("exact user intent"),
			createAssistantMessage(),
			createToolResult("large result"),
		];
		const payload = buildCompressionPayload(messages, 5);
		const compressed = payload.messages.map((message): OpenAIMessage => {
			if (message.role === "user") return { ...message, content: "changed intent" };
			return message;
		});

		const result = applyCompressionResult(messages, payload.mappings, compressed, { minMessageChars: 5 });

		expect(result).toEqual({ ok: false, reason: "non-candidate-changed:user" });
	});

	it("does not include user image bytes in the compression payload", () => {
		const messages = [
			{
				role: "user",
				content: [
					{ type: "text", text: "inspect this" },
					{ type: "image", data: "base64-image-data", mimeType: "image/png" },
				],
				timestamp: 0,
			} as AgentMessage,
			createAssistantMessage(),
			createToolResult("large result"),
		];

		const payload = buildCompressionPayload(messages, 5);

		expect(payload.messages[0]).toEqual({ role: "user", content: "inspect this" });
		expect(JSON.stringify(payload.messages)).not.toContain("base64-image-data");
	});

	it("replaces image-only user messages with a small compression placeholder", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "image", data: "base64-image-data", mimeType: "image/png" }],
				timestamp: 0,
			} as AgentMessage,
			createAssistantMessage(),
			createToolResult("large result"),
		];

		const payload = buildCompressionPayload(messages, 5);

		expect(payload.messages[0]).toEqual({
			role: "user",
			content: "[image omitted from Headroom compression payload]",
		});
		expect(JSON.stringify(payload.messages)).not.toContain("base64-image-data");
	});

	it("does not treat small tool results as compression candidates", () => {
		const messages = [createUserMessage("go"), createAssistantMessage(), createToolResult("small")];

		const payload = buildCompressionPayload(messages, 100);

		expect(payload.candidateCount).toBe(0);
	});
});
