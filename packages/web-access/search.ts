import { hasExaApiKey, searchWithExa } from "./exa.js";
import { isOpenAISubscriptionModelSelected, type OpenAISearchContext, searchWithOpenAI } from "./openai-search.js";
import type { SearchOptions, SearchResponse } from "./search-types.js";

/** `auto` only spends this long on OpenAI before falling back to Exa; an explicit `openai` keeps the 60s default. */
const AUTO_OPENAI_TIMEOUT_MS = 20_000;
const MAX_FALLBACK_REASON_CHARS = 200;

export type SearchProvider = "auto" | "exa" | "openai";

export interface AttributedSearchResponse extends SearchResponse {
	provider: "exa" | "openai";
}

export interface FullSearchOptions extends SearchOptions {
	includeContent?: boolean;
	/** `auto` (default) tries OpenAI first on a Codex subscription model, then Exa. */
	provider?: SearchProvider;
}

export function isSearchProvider(value: unknown): value is SearchProvider {
	return value === "auto" || value === "exa" || value === "openai";
}

async function searchExa(query: string, options: FullSearchOptions): Promise<AttributedSearchResponse> {
	const result = await searchWithExa(query, options);
	if (result && "exhausted" in result) {
		throw new Error(
			"Exa monthly free tier exhausted (1,000 requests). Resets next month.\n" +
				"  Upgrade at exa.ai/pricing or use Exa MCP without an API key.",
		);
	}
	if (result) return { ...result, provider: "exa" };
	throw new Error(
		hasExaApiKey()
			? "Exa search returned no results."
			: "Exa search unavailable. Set EXA_API_KEY (or exaApiKey) in ~/.pi/web-search.json or check Exa MCP access.",
	);
}

export async function search(
	query: string,
	options: FullSearchOptions = {},
	ctx?: OpenAISearchContext,
): Promise<AttributedSearchResponse> {
	const provider = options.provider ?? "auto";
	if (provider === "exa") return searchExa(query, options);
	if (provider === "openai") {
		// Explicitly requested: no fallback, so a missing login or an API failure surfaces as is.
		return { ...(await searchWithOpenAI(query, options, ctx)), provider: "openai" };
	}

	if (!isOpenAISubscriptionModelSelected(ctx)) return searchExa(query, options);
	let openaiError: unknown;
	try {
		const openai = await searchWithOpenAI(query, { ...options, timeoutMs: AUTO_OPENAI_TIMEOUT_MS }, ctx);
		return { ...openai, provider: "openai" };
	} catch (err) {
		if (options.signal?.aborted) throw err;
		openaiError = err;
	}
	try {
		const exa = await searchExa(query, options);
		// Let the model know why the answer is not from the subscription search it would expect.
		const reason = (openaiError instanceof Error ? openaiError.message : String(openaiError)).replace(/\s+/g, " ");
		const short =
			reason.length > MAX_FALLBACK_REASON_CHARS ? `${reason.slice(0, MAX_FALLBACK_REASON_CHARS)}...` : reason;
		const note = `Note: OpenAI search failed (${short}); results below come from Exa.`;
		return { ...exa, answer: exa.answer ? `${note}\n\n${exa.answer}` : note };
	} catch (err) {
		if (options.signal?.aborted) throw err;
		const exaMessage = err instanceof Error ? err.message : String(err);
		const openaiMessage = openaiError instanceof Error ? openaiError.message : String(openaiError);
		throw new Error(`${exaMessage}\nOpenAI search also failed: ${openaiMessage}`);
	}
}
