import { formatToolCallPlain } from "./format.js";

const THOUGHT_PREVIEW_MAX_CHARS = 80;
const ACTIVITY_PREVIEW_MAX_CHARS = 240;

function getFirstNonEmptyLine(raw: string): string | undefined {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)[0];
}

export function extractThoughtText(raw: string): string | undefined {
	const firstLine = getFirstNonEmptyLine(raw);
	if (!firstLine) return undefined;

	const clean = firstLine
		.replace(/^#+\s*/, "")
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.trim();
	if (!clean) return undefined;
	return clean.slice(0, THOUGHT_PREVIEW_MAX_CHARS);
}

export function extractActivityPreviewFromTextDelta(raw: string): string | undefined {
	const lastLine = raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.pop();
	if (!lastLine) return undefined;
	return lastLine.slice(0, ACTIVITY_PREVIEW_MAX_CHARS);
}

export function formatPiToolExecutionPreview(toolName: string, args: unknown): string {
	const normalizedArgs = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	return `→ ${formatToolCallPlain(toolName, normalizedArgs)}`;
}
