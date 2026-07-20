/**
 * Context-overflow detection and proactive guard ceilings for subagent runs.
 *
 * Two related concerns live here:
 *
 * 1. Detection (②): recognizing when a subagent failed because it exceeded the
 *    model's context window, so callers can classify the failure and recover
 *    partial findings instead of surfacing a raw provider error.
 *
 * 2. Proactive guard (④): some providers register a context window that is
 *    unsafe for long internal tool loops. Some `openai-codex` models expose a
 *    larger registry window than the backend actually enforces; Spark correctly
 *    reports 128k but can still cross the threshold between tool turns because
 *    pi checks native compaction only after the whole agent run. We watch
 *    reported tokens live and stop just below each known cliff, preserving
 *    findings.
 *
 * Overflow patterns are aligned with `@earendil-works/pi-ai`'s OVERFLOW_PATTERNS.
 */

/** Error-message patterns indicating the request exceeded the model context window. */
const OVERFLOW_PATTERNS: RegExp[] = [
	/prompt is too long/i, // Anthropic token overflow
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI / codex (Completions & Responses API)
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/model_context_window_exceeded/i, // z.ai
	/prompt too long; exceeded (?:max )?context length/i, // Ollama
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
];

/** Patterns that look like overflow but are actually throttling/rate-limit errors. */
const NON_OVERFLOW_PATTERNS: RegExp[] = [
	/^(throttling error|service unavailable):/i,
	/rate limit/i,
	/too many requests/i,
];

/** Signature emitted by our own proactive context guard (see resolveContextGuardCeiling). */
export const CONTEXT_GUARD_SIGNATURE = "context guard:";

/**
 * True when the given error/output text indicates a context-window overflow
 * (either a provider overflow error or our own proactive guard stop).
 */
export function isContextOverflowText(text: string | undefined | null): boolean {
	if (!text) return false;
	if (text.includes(CONTEXT_GUARD_SIGNATURE)) return true;
	if (NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
	return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

// ─── Proactive guard ceilings ───────────────────────────────────────────────

/**
 * Per-model-prefix effective ceilings (tokens). Set below the provider's real
 * hard limit so we cut over one turn before the cliff and keep findings.
 * Only applied to the pi runtime; the claude runtime handles its own limits.
 */
const GUARD_CEILINGS: Array<{ prefix: string; tokens: number }> = [
	// GPT-5.3 Codex Spark has a hard 128k text-only window. Pi checks native
	// threshold compaction only after the full agent run, not between internal
	// tool-use turns, so stop at 115k before one large read/reasoning turn can
	// cross the provider cliff.
	{ prefix: "openai-codex/gpt-5.3-codex-spark", tokens: 115_000 },
	// GPT-5.6 Codex models expose a 372k input window in pi. Keep the same 37k
	// safety margin used by the older 272k-window models so long tool turns stop
	// at 335k while partial findings can still be preserved. The family prefix
	// covers Sol, Terra, and Luna.
	{ prefix: "openai-codex/gpt-5.6", tokens: 335_000 },
	// Observed 272k-window codex models hard-error around ~264k with a raw
	// provider error and no compaction. Cut at 235k to preserve the exploration
	// so far. Other unlisted models fall back to overflow detection/recovery (②).
	{ prefix: "openai-codex/gpt-5.5", tokens: 235_000 },
	// gpt-5.4 and gpt-5.4-mini both use a 272k window and are covered via startsWith.
	{ prefix: "openai-codex/gpt-5.4", tokens: 235_000 },
];

const GUARD_ENV_KEY = "PI_SUBAGENT_CONTEXT_GUARD_TOKENS";

function parseEnvCeiling(): number | undefined {
	const raw = process.env[GUARD_ENV_KEY];
	if (!raw) return undefined;
	const value = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

/**
 * Resolve the proactive context-guard ceiling (in tokens) for a subagent run.
 *
 * Returns undefined when no guard applies (non-pi runtime, unknown model, or
 * guard explicitly disabled) — in which case we defer to the provider / pi's
 * native compaction. An env override (PI_SUBAGENT_CONTEXT_GUARD_TOKENS) wins
 * for pi-runtime models; set it to 0 to disable.
 */
export function resolveContextGuardCeiling(model: string | undefined, runtime: string | undefined): number | undefined {
	if (runtime && runtime !== "pi") return undefined;

	const envRaw = process.env[GUARD_ENV_KEY];
	if (envRaw !== undefined) {
		// Explicit disable via 0/empty; otherwise a positive override applies to all pi models.
		const parsed = parseEnvCeiling();
		return parsed;
	}

	if (!model) return undefined;
	const match = GUARD_CEILINGS.find((entry) => model.startsWith(entry.prefix));
	return match?.tokens;
}

export function shouldTripContextGuard(params: {
	stopReason?: string;
	peakContextTokens: number;
	ceiling?: number;
	alreadyTripped: boolean;
}): boolean {
	if (params.alreadyTripped) return false;
	if (params.ceiling === undefined) return false;
	if (params.stopReason !== "toolUse") return false;
	return params.peakContextTokens >= params.ceiling;
}
