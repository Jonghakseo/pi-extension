/** Shared search result types, dependency-free. */
import type { ExtractedContent } from "./extract.js";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	/** Exa content category, e.g. "news" or "research paper". */
	category?: string;
	/** Request timeout for providers that support it. OpenAI defaults to 60s. */
	timeoutMs?: number;
	signal?: AbortSignal;
}
