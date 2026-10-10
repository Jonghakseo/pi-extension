import { hasExaApiKey, searchWithExa } from "./exa.js";
import { isOpenAISubscriptionModelSelected, type OpenAISearchContext, searchWithOpenAI } from "./openai-search.js";
import type { SearchOptions, SearchResponse } from "./search-types.js";

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
		return { ...(await searchWithOpenAI(query, options, ctx)), provider: "openai" };
	} catch (err) {
		if (options.signal?.aborted) throw err;
		openaiError = err;
	}
	try {
		return await searchExa(query, options);
	} catch (err) {
		if (options.signal?.aborted) throw err;
		const exaMessage = err instanceof Error ? err.message : String(err);
		const openaiMessage = openaiError instanceof Error ? openaiError.message : String(openaiError);
		throw new Error(`${exaMessage}\nOpenAI search also failed: ${openaiMessage}`);
	}
}
