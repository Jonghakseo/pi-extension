import { generateShortLabel, type ShortLabelContext } from "./utils/short-label.js";
import { normalizeWhitespace } from "./utils/string-utils.js";

export const SUBAGENT_DISPLAY_TASK_SYSTEM_PROMPT =
	"Analyze the subagent task and return a single short progress label of at most 20 characters. Hide temporary paths (/tmp/...), internal phrases such as read/follow the instructions, and output only the human-readable objective.";

export const MAX_NAME_LENGTH = 30;

const DISPLAY_TASK_INPUT_MAX_CHARS = 600;
const GENERIC_DISPLAY_TASKS = new Set(["follow the instructions", "follow instructions", "read context"]);

export type DisplayTaskRefreshToken = {
	task: string;
	startedAt: number;
};

function stripMarkdownNoise(value: string): string {
	return value
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1");
}

export function createDisplayTaskRefreshToken(run: { task: string; startedAt: number }): DisplayTaskRefreshToken {
	return { task: run.task, startedAt: run.startedAt };
}

export function isDisplayTaskRefreshTokenCurrent(
	run: { task: string; startedAt: number },
	token: DisplayTaskRefreshToken,
): boolean {
	return run.task === token.task && run.startedAt === token.startedAt;
}

export function normalizeSubagentTaskText(task: string): string {
	return stripMarkdownNoise(normalizeWhitespace(task));
}

export function extractNameFromResult(content: ReadonlyArray<{ type: string; text?: string }>): string {
	const text = content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("")
		.trim();

	return text.slice(0, MAX_NAME_LENGTH);
}

export function buildSubagentDisplayTaskFallback(task: string): string {
	const normalized = normalizeSubagentTaskText(task)
		.replace(/^\[continue #\d+\]\s*/i, "")
		.replace(/\bread\s+\/tmp\/\S+(?:\s+and\s+\/tmp\/\S+)*/gi, " ")
		.replace(/\/tmp\/\S+/g, " ")
		.replace(/\b(?:and\s+)?follow the instructions\b/gi, " ")
		.replace(/\b(?:and\s+)?follow instructions\b/gi, " ")
		.replace(/\b(?:use|using) the provided context\b/gi, " ")
		.replace(/\battached context\b/gi, " ")
		.replace(/^\bthen\b\s+/i, "")
		.replace(/^[:;,.\-–—|/\\]+\s*/, "")
		.replace(/\s+[:;,.\-–—|/\\]+$/g, "")
		.replace(/\s{2,}/g, " ")
		.trim()
		.replace(/^\bthen\b\s+/i, "");

	if (normalized) return normalized.slice(0, MAX_NAME_LENGTH).replace(/[\s:;,.\-–—|/\\]+$/g, "");

	const heading = normalizeSubagentTaskText(task).match(/#{1,6}\s+([^\n]+)/);
	if (heading?.[1]) return normalizeWhitespace(heading[1]).slice(0, MAX_NAME_LENGTH);

	return normalizeSubagentTaskText(task)
		.slice(0, MAX_NAME_LENGTH)
		.replace(/[\s:;,.\-–—|/\\]+$/g, "");
}

export function shouldSummarizeSubagentTask(task: string, fallback: string): boolean {
	const normalizedTask = normalizeSubagentTaskText(task).toLowerCase();
	const normalizedFallback = normalizeWhitespace(fallback).toLowerCase();
	if (!normalizedFallback) return true;
	if (normalizedTask.includes("/tmp/")) return true;
	if (normalizedTask.startsWith("[continue #")) return true;
	if (normalizedFallback.length >= MAX_NAME_LENGTH) return true;
	return GENERIC_DISPLAY_TASKS.has(normalizedFallback);
}

function buildDisplayTaskContext(task: string, fallback: string): string {
	const clippedTask = task.slice(0, DISPLAY_TASK_INPUT_MAX_CHARS);
	return [`Original: ${clippedTask}`, `Normalized: ${fallback}`].join("\n");
}

export async function summarizeSubagentDisplayTask(task: string, ctx: ShortLabelContext): Promise<string> {
	const fallback = buildSubagentDisplayTaskFallback(task);
	const summary = await generateShortLabel(ctx, {
		systemPrompt: SUBAGENT_DISPLAY_TASK_SYSTEM_PROMPT,
		prompt: buildDisplayTaskContext(task, fallback),
		extractText: extractNameFromResult,
	});
	return summary || fallback;
}
