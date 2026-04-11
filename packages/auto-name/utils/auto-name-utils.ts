/**
 * Pure utility functions for auto-name extension.
 * Extracted for testability — no I/O, no pi SDK dependencies.
 */

import * as os from "node:os";
import * as path from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────

/** Must match subagent/session.ts:SUBAGENT_SESSION_DIR */
export const SUBAGENT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "subagents");

export const NAME_SYSTEM_PROMPT =
	"사용자 메시지를 분석해서 세션의 목적을 20자 이내 한 줄로 추출해. 오직 목적 텍스트만 출력하고, 설명이나 다른 텍스트는 절대 출력하지 마.";

/** Max chars for the user message sent to the LLM. */
export const MAX_MESSAGE_LENGTH = 500;

/** Max chars for the resulting session name. */
export const MAX_NAME_LENGTH = 30;

/** Max chars shown in the status bar. */
export const MAX_STATUS_CHARS = 90;

/** Only a fully completed response should be used as a session name. */
export const SUCCESSFUL_STOP_REASON = "stop";

// ── Pure Functions ───────────────────────────────────────────────────────────

/**
 * Check if a session file path belongs to the subagent sessions directory.
 * Returns true if the path starts with SUBAGENT_SESSION_DIR.
 */
export function isSubagentSessionPath(sessionFilePath: string | undefined): boolean {
	if (!sessionFilePath) return false;
	return (
		sessionFilePath.startsWith(SUBAGENT_SESSION_DIR + path.sep) ||
		sessionFilePath.startsWith(`${SUBAGENT_SESSION_DIR}/`)
	);
}

/**
 * Safely extract session file path from an ExtensionContext-like object.
 * Returns undefined if extraction fails.
 */
export function extractSessionFilePath(sessionManager: unknown): string | undefined {
	try {
		if (sessionManager && typeof sessionManager === "object" && "getSessionFile" in sessionManager) {
			const getSessionFile = (sessionManager as Record<string, unknown>).getSessionFile;
			if (typeof getSessionFile === "function") {
				const raw = String(getSessionFile() ?? "");
				const cleaned = raw.replace(/[\r\n\t]+/g, "").trim();
				return cleaned || undefined;
			}
		}
	} catch {
		// Ignore errors
	}
	return undefined;
}

/**
 * Format a session name for status bar display.
 * Normalizes whitespace and clips to MAX_STATUS_CHARS.
 */
export function formatNameStatus(name: string): string {
	const singleLine = name.replace(/\s+/g, " ").trim();
	return singleLine.length > MAX_STATUS_CHARS ? `${singleLine.slice(0, MAX_STATUS_CHARS - 1)}…` : singleLine;
}

/**
 * Build the user-message text sent to the LLM for name detection.
 * Truncates to MAX_MESSAGE_LENGTH.
 */
export function buildNameContext(userMessage: string): string {
	return `사용자 메시지: ${userMessage.slice(0, MAX_MESSAGE_LENGTH)}`;
}

/**
 * Check whether a model result completed normally.
 * Only fully completed responses should be used for session naming.
 */
export function isSuccessfulResult(stopReason: string | undefined): boolean {
	return stopReason === SUCCESSFUL_STOP_REASON;
}

/**
 * Extract the session name text from an LLM AssistantMessage-like result.
 * Filters to text content, joins, trims, and clips to MAX_NAME_LENGTH.
 */
export function extractNameFromResult(content: ReadonlyArray<{ type: string; text?: string }>): string {
	const text = content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("")
		.trim();

	return text.slice(0, MAX_NAME_LENGTH);
}
