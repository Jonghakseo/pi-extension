import type { ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type {
	AgentMessage,
	ApplyCompressionOptions,
	ApplyCompressionResult,
	CompressionMapping,
	CompressionPayload,
	OpenAIAssistantMessage,
	OpenAIMessage,
	OpenAIToolCall,
} from "./types.ts";

type AnyMessage = AgentMessage & { role?: string; content?: unknown; timestamp?: number };

interface MessageWithContent {
	content: unknown;
}

const STANDARD_COMPRESSIBLE_ROLES = new Set(["user", "assistant", "toolResult"]);

export function buildCompressionPayload(messages: AgentMessage[], minMessageChars: number): CompressionPayload {
	const mappings: CompressionMapping[] = [];
	let candidateCount = 0;

	for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex++) {
		const source = messages[sourceIndex] as AnyMessage;
		const converted = convertMessage(source);
		if (!converted) continue;

		const originalText = extractOpenAIText(converted);
		const applyTo = source.role === "toolResult" && originalText.length >= minMessageChars ? "toolResult" : null;
		if (applyTo) candidateCount++;
		mappings.push({ sourceIndex, message: converted, applyTo, originalText });
	}

	return {
		messages: mappings.map((mapping) => mapping.message),
		mappings,
		candidateCount,
	};
}

export function applyCompressionResult(
	originalMessages: AgentMessage[],
	mappings: CompressionMapping[],
	compressedMessages: OpenAIMessage[],
	_options: ApplyCompressionOptions,
): ApplyCompressionResult {
	if (compressedMessages.length !== mappings.length) {
		return { ok: false, reason: "message-count-changed" };
	}

	const nextMessages = structuredClone(originalMessages) as AgentMessage[];
	let appliedMessages = 0;

	for (let index = 0; index < mappings.length; index++) {
		const mapping = mappings[index];
		const compressed = compressedMessages[index];
		const validation = validateAlignedMessage(mapping.message, compressed);
		if (!validation.ok) return validation;

		const nextText = extractOpenAIText(compressed);
		if (nextText === mapping.originalText) continue;

		if (mapping.applyTo !== "toolResult") {
			return { ok: false, reason: `non-candidate-changed:${mapping.message.role}` };
		}

		const target = nextMessages[mapping.sourceIndex] as AnyMessage;
		if (target.role !== "toolResult") {
			return { ok: false, reason: "source-role-mismatch" };
		}

		if (!replaceTextContent(target, nextText)) {
			return { ok: false, reason: "target-content-unreplaceable" };
		}
		appliedMessages++;
	}

	if (appliedMessages === 0) {
		return { ok: false, reason: "no-applicable-message-changed" };
	}

	return { ok: true, messages: nextMessages, appliedMessages };
}

function convertMessage(message: AnyMessage): OpenAIMessage | undefined {
	if (!message.role || !STANDARD_COMPRESSIBLE_ROLES.has(message.role)) return undefined;
	switch (message.role) {
		case "user":
			return convertUserMessage(message);
		case "assistant":
			return convertAssistantMessage(message);
		case "toolResult":
			return convertToolResultMessage(message);
		default:
			return undefined;
	}
}

function convertUserMessage(message: AnyMessage): OpenAIMessage | undefined {
	if (!hasContent(message)) return undefined;
	if (typeof message.content === "string") {
		return { role: "user", content: message.content };
	}
	if (!Array.isArray(message.content)) return undefined;

	const text = message.content
		.filter((part): part is TextContent => isTextContent(part))
		.map((part) => part.text)
		.join("\n");
	if (text) return { role: "user", content: text };
	const hasImages = message.content.some((part) => isImageContent(part));
	return hasImages ? { role: "user", content: "[image omitted from Headroom compression payload]" } : undefined;
}

function convertAssistantMessage(message: AnyMessage): OpenAIAssistantMessage | undefined {
	if (!hasContent(message) || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter((part): part is TextContent => isTextContent(part))
		.map((part) => part.text)
		.join("");
	const toolCalls = message.content.filter((part): part is ToolCall => isToolCall(part));
	if (!text && toolCalls.length === 0) return undefined;

	const converted: OpenAIAssistantMessage = {
		role: "assistant",
		content: text || null,
	};
	if (toolCalls.length > 0) {
		converted.tool_calls = toolCalls.map(convertToolCall);
	}
	return converted;
}

function convertToolResultMessage(message: AnyMessage): OpenAIMessage | undefined {
	if (!hasContent(message)) return undefined;
	const toolCallId = readStringProperty(message, "toolCallId");
	if (!toolCallId) return undefined;
	return {
		role: "tool",
		content: extractTextFromContent(message.content),
		tool_call_id: toolCallId,
	};
}

function convertToolCall(toolCall: ToolCall): OpenAIToolCall {
	return {
		id: toolCall.id,
		type: "function",
		function: {
			name: toolCall.name,
			arguments: JSON.stringify(toolCall.arguments),
		},
	};
}

function validateAlignedMessage(
	original: OpenAIMessage,
	compressed: OpenAIMessage,
): { ok: true } | { ok: false; reason: string } {
	if (original.role !== compressed.role) {
		return { ok: false, reason: `role-changed:${original.role}->${compressed.role}` };
	}
	if (original.role === "tool" && compressed.role === "tool") {
		if (original.tool_call_id !== compressed.tool_call_id) return { ok: false, reason: "tool-call-id-changed" };
	}
	if (original.role === "assistant" && compressed.role === "assistant") {
		const originalIds = (original.tool_calls ?? []).map((call) => call.id).join("\n");
		const compressedIds = (compressed.tool_calls ?? []).map((call) => call.id).join("\n");
		if (originalIds !== compressedIds) return { ok: false, reason: "assistant-tool-calls-changed" };
	}
	return { ok: true };
}

function extractOpenAIText(message: OpenAIMessage): string {
	if (message.role === "assistant") return typeof message.content === "string" ? message.content : "";
	if (message.role === "tool" || message.role === "system") return message.content;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is TextContent => isTextContent(part))
		.map((part) => part.text)
		.join("\n");
}

function replaceTextContent(message: MessageWithContent, text: string): boolean {
	if (typeof message.content === "string") {
		message.content = text;
		return true;
	}
	if (!Array.isArray(message.content)) return false;
	const imageParts = message.content.filter((part): part is ImageContent => isImageContent(part));
	message.content = [{ type: "text", text }, ...imageParts];
	return true;
}

function hasContent(message: AnyMessage): message is AnyMessage & MessageWithContent {
	return "content" in message;
}

function isTextContent(value: unknown): value is TextContent {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): value is ImageContent {
	return (
		isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
	);
}

function isToolCall(value: unknown): value is ToolCall {
	return (
		isRecord(value) &&
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		isRecord(value.arguments)
	);
}

function readStringProperty(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const property = value[key];
	return typeof property === "string" ? property : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
