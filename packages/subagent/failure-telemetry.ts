import { isContextOverflowText } from "./context-limits.js";

export type SubagentErrorClass =
	| "context_overflow"
	| "overloaded"
	| "rate_limit"
	| "tool_error"
	| "aborted"
	| "process_error"
	| "unknown";

export interface FailureTelemetryInput {
	failed: boolean;
	stopReason?: string;
	exitCode?: number;
	errorMessage?: string;
	stderr?: string;
	output?: string;
}

const OVERLOADED_PATTERNS = [
	/servers? (?:are|is) currently overloaded/i,
	/server overloaded/i,
	/service unavailable/i,
	/\b(?:http\s*)?5(?:03|29)\b/i,
];

const RATE_LIMIT_PATTERNS = [/rate limit/i, /too many requests/i, /\bhttp\s*429\b/i, /\b429\b.*request/i];

const TOOL_ERROR_PATTERNS = [
	/tool(?: execution| call)? (?:failed|error)/i,
	/tool_execution_error/i,
	/permission denied for tools?/i,
	/invalid tool/i,
];

export function classifySubagentFailure(input: FailureTelemetryInput): SubagentErrorClass | undefined {
	if (!input.failed) return undefined;
	const text = [input.errorMessage, input.stderr, input.output].filter(Boolean).join("\n");

	if (isContextOverflowText(text)) return "context_overflow";
	if (OVERLOADED_PATTERNS.some((pattern) => pattern.test(text))) return "overloaded";
	if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return "rate_limit";
	if (input.stopReason === "aborted") return "aborted";
	if (TOOL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) return "tool_error";
	if ((input.exitCode ?? 0) !== 0) return "process_error";
	return "unknown";
}

export function countTextChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const part of content) {
		if (typeof part === "string") {
			chars += part.length;
			continue;
		}
		if (!part || typeof part !== "object") continue;
		const record = part as Record<string, unknown>;
		if (typeof record.text === "string") chars += record.text.length;
		else if (typeof record.content === "string") chars += record.content.length;
		else if (Array.isArray(record.content)) chars += countTextChars(record.content);
	}
	return chars;
}
