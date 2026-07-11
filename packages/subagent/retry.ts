import { getFinalOutput } from "./runner.js";
import type { SingleResult } from "./types.js";

export const MAX_SUBAGENT_AUTO_RETRIES = 3;
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

export interface RetryDecision {
	retryable: boolean;
	reason?: string;
}

export interface RetryScheduleInfo {
	retryIndex: number;
	maxRetries: number;
	delayMs: number;
	reason: string;
}

export interface InvokeWithAutoRetryOptions {
	invoke: () => Promise<SingleResult>;
	signal?: AbortSignal;
	maxRetries?: number;
	onRetryScheduled?: (info: RetryScheduleInfo) => void | Promise<void>;
}

function buildFailureText(result: SingleResult): string {
	return [
		result.errorMessage,
		result.stderr,
		getFinalOutput(result.messages),
		result.stopReason ? `stopReason=${result.stopReason}` : "",
	]
		.filter((value) => typeof value === "string" && value.trim().length > 0)
		.join("\n");
}

const TRANSIENT_FAILURE_PATTERNS: RegExp[] = [
	/\bnetwork\b/i,
	/\bfetch failed\b/i,
	/\bconnection reset\b/i,
	/\bsocket hang up\b/i,
	/\btemporar(?:y|ily) unavailable\b/i,
	/\btemporar(?:y|ily) failure\b/i,
	/\btimeout\b/i,
	/\btimed out\b/i,
	/\bETIMEDOUT\b/i,
	/\bECONNRESET\b/i,
	/\bECONNREFUSED\b/i,
	/\bENOTFOUND\b/i,
	/\bEHOSTUNREACH\b/i,
	/\b503\b/i,
	/\b502\b/i,
	/\b504\b/i,
	/\b429\b/i,
	/\brate limit\b/i,
	/\btoo many requests\b/i,
	/\boverloaded\b/i,
	/\bover capacity\b/i,
	/\bservice unavailable\b/i,
	/\bserver_error\b/i,
	/\bserver error\b/i,
	/an error occurred while processing your request/i,
	/\bupstream\b/i,
	/\bTLS\b/i,
];

function matchesTransientPattern(text: string): boolean {
	return TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function diagnoseRetryableResult(result: SingleResult): RetryDecision {
	if (result.stopReason === "aborted") return { retryable: false };

	const finalOutput = getFinalOutput(result.messages).trim();
	if (result.exitCode === 0 && result.stopReason !== "error" && finalOutput) {
		return { retryable: false };
	}

	const failureText = buildFailureText(result);
	if (!failureText) return { retryable: false };
	if (!matchesTransientPattern(failureText)) return { retryable: false };

	const firstLine = failureText
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	return {
		retryable: true,
		reason: firstLine || "Transient network/service failure detected.",
	};
}

export function diagnoseRetryableError(error: unknown): RetryDecision {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
	if (!text || !matchesTransientPattern(text)) return { retryable: false };
	return { retryable: true, reason: text };
}

async function waitWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return;
	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Subagent retry aborted"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, delayMs);
		if (signal) signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function invokeWithAutoRetry({
	invoke,
	signal,
	maxRetries = MAX_SUBAGENT_AUTO_RETRIES,
	onRetryScheduled,
}: InvokeWithAutoRetryOptions): Promise<{ result: SingleResult; retryCount: number }> {
	let retryCount = 0;

	while (true) {
		try {
			const result = await invoke();
			const retryDecision = diagnoseRetryableResult(result);
			if (!retryDecision.retryable || retryCount >= maxRetries) {
				return { result, retryCount };
			}

			retryCount += 1;
			const delayMs = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)] ?? 2_000;
			await onRetryScheduled?.({
				retryIndex: retryCount,
				maxRetries,
				delayMs,
				reason: retryDecision.reason || "Transient network/service failure detected.",
			});
			await waitWithAbort(delayMs, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			const retryDecision = diagnoseRetryableError(error);
			if (!retryDecision.retryable || retryCount >= maxRetries) throw error;

			retryCount += 1;
			const delayMs = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)] ?? 2_000;
			await onRetryScheduled?.({
				retryIndex: retryCount,
				maxRetries,
				delayMs,
				reason: retryDecision.reason || "Transient network/service failure detected.",
			});
			await waitWithAbort(delayMs, signal);
		}
	}
}
