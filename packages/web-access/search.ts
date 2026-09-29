import { hasExaApiKey, searchWithExa } from "./exa.js";
import type { SearchOptions, SearchResponse } from "./search-types.js";

export interface AttributedSearchResponse extends SearchResponse {
	provider: "exa";
}

export interface FullSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
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
