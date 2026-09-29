import type { Message } from "@earendil-works/pi-ai";

// pi-ai 0.87의 Message 유니언은 JsonObject·api 리터럴 등 엄격한 제약이 있다.
// 테스트 픽스처는 런타임 형태만 정확하면 충분해 캐스팅으로 우회한다.
const ts = Date.now();
const assistBase = {
	api: "messages" as never,
	provider: "anthropic" as never,
	model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	timestamp: ts,
};

export const userMsg = (text: string): Message =>
	({
		role: "user",
		content: text,
		timestamp: ts,
	}) as unknown as Message;

export const assistantText = (text: string): Message =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		...assistBase,
		stopReason: "stop",
	}) as unknown as Message;

export const assistantWithThinking = (text: string, thinking: string): Message =>
	({
		role: "assistant",
		content: [
			{ type: "thinking", thinking },
			{ type: "text", text },
		],
		...assistBase,
		stopReason: "stop",
	}) as unknown as Message;

export const assistantWithToolCall = (name: string, args: Record<string, unknown>): Message =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id: "tc_1", name, arguments: args as never }],
		...assistBase,
		stopReason: "toolUse",
	}) as unknown as Message;

export const toolResult = (name: string, text: string): Message =>
	({
		role: "toolResult",
		toolCallId: "tc_1",
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	}) as unknown as Message;
