import type { ContextEvent } from "@earendil-works/pi-coding-agent";

// AgentMessage lives in @earendil-works/pi-agent-core, which is only a transitive
// dependency here. Derive it from the publicly exported ContextEvent payload so the
// package depends solely on @earendil-works/pi-coding-agent + @earendil-works/pi-ai.
export type AgentMessage = ContextEvent["messages"][number];

export interface TextContentPart {
	type: "text";
	text: string;
}

export interface ImageContentPart {
	type: "image_url";
	image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type OpenAIContentPart = TextContentPart | ImageContentPart;

export interface OpenAISystemMessage {
	role: "system";
	content: string;
}

export interface OpenAIUserMessage {
	role: "user";
	content: string | OpenAIContentPart[];
}

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface OpenAIAssistantMessage {
	role: "assistant";
	content: string | null;
	tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolMessage {
	role: "tool";
	content: string;
	tool_call_id: string;
}

export type OpenAIMessage = OpenAISystemMessage | OpenAIUserMessage | OpenAIAssistantMessage | OpenAIToolMessage;

export interface CompressResult {
	messages: OpenAIMessage[];
	tokensBefore: number;
	tokensAfter: number;
	tokensSaved: number;
	compressionRatio: number;
	transformsApplied: string[];
	ccrHashes: string[];
	compressed: boolean;
}

export interface HeadroomConfig {
	enabled: boolean;
	baseUrl: string;
	allowRemote: boolean;
	autoStart: boolean;
	command: string;
	minContextTokens: number;
	minMessageChars: number;
	timeoutMs: number;
}

export interface HeadroomStats {
	attempts: number;
	applied: number;
	guardSkips: number;
	tokensSaved: number;
	last?: {
		tokensBefore: number;
		tokensAfter: number;
		tokensSaved: number;
		compressionRatio: number;
		transformsApplied: string[];
		ccrHashes: string[];
		appliedMessages: number;
	};
	lastError?: string;
	lastSkipReason?: string;
}

export interface CompressionMapping {
	sourceIndex: number;
	message: OpenAIMessage;
	applyTo: "toolResult" | null;
	originalText: string;
}

export interface CompressionPayload {
	messages: OpenAIMessage[];
	mappings: CompressionMapping[];
	candidateCount: number;
}

export interface ApplyCompressionOptions {
	minMessageChars: number;
}

export type ApplyCompressionResult =
	| { ok: true; messages: AgentMessage[]; appliedMessages: number }
	| { ok: false; reason: string };
