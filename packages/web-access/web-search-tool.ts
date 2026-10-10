import { StringEnum } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { normalizeQueryList } from "./config-runtime.js";
import { sanitizeExtractedContents } from "./data-uri-sanitize.js";
import type { ExtractedContent } from "./extract.js";
import { formatSearchSummary, hasFullInlineCoverage, stripThumbnails } from "./result-format.js";
import { isSearchProvider, search } from "./search.js";
import { state } from "./state.js";
import {
	generateId,
	type QueryResultData,
	type StoredSearchData,
	storeFetchedContentResult,
	storeResult,
} from "./storage.js";

// Shape of `structuredContent`, the data a Pi codemode script receives instead of the text output.
const nullableString = (description: string) => Type.Union([Type.String(), Type.Null()], { description });
const webSearchOutputSchema = Type.Object({
	responseId: Type.String({ description: "Id of the stored search results" }),
	fetchId: nullableString("Stored page content id when includeContent fetched or started fetching content, else null"),
	queries: Type.Array(
		Type.Object({
			query: Type.String(),
			answer: Type.String({ description: "Provider answer text, empty when the provider returned only results" }),
			error: nullableString("Why this query failed, null on success"),
			provider: Type.Optional(Type.String()),
			results: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), snippet: Type.String() })),
		}),
	),
});

function searchStructuredContent(
	responseId: string,
	fetchId: string | null,
	results: QueryResultData[],
): AgentToolResult<unknown>["structuredContent"] {
	return {
		responseId,
		fetchId,
		queries: results.map(({ query, answer, error, provider, results: hits }) => ({
			query,
			answer,
			error,
			...(provider ? { provider } : {}),
			results: hits.map(({ title, url, snippet }) => ({ title, url, snippet })),
		})),
	};
}

const isRecencyFilter = (value: unknown): value is "day" | "week" | "month" | "year" =>
	value === "day" || value === "week" || value === "month" || value === "year";

function startBackgroundFetch(pi: ExtensionAPI, urls: string[]): string | null {
	if (urls.length === 0) return null;
	const fetchId = generateId();
	const controller = new AbortController();
	state.pendingFetches.set(fetchId, controller);
	// Heavy extract module graph loads lazily on first background fetch.
	import("./extract.js")
		.then((m) => m.fetchAllContent(urls, controller.signal))
		.then((fetched) => {
			if (!state.sessionActive || !state.pendingFetches.has(fetchId)) return;
			pi.appendEntry(
				"web-search-results",
				storeFetchedContentResult(fetchId, {
					id: fetchId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetched),
				}),
			);
			const ok = fetched.filter((f) => !f.error).length;
			pi.sendMessage(
				{
					customType: "web-search-content-ready",
					content: `Content fetched for ${ok}/${fetched.length} URLs [${fetchId}]. Full page content now available.`,
					display: true,
				},
				{ triggerTurn: true },
			);
		})
		.catch((err) => {
			if (!state.sessionActive || !state.pendingFetches.has(fetchId)) return;
			const message = err instanceof Error ? err.message : String(err);
			const isAbort = (err instanceof Error && err.name === "AbortError") || message.toLowerCase().includes("abort");
			if (!isAbort) {
				pi.sendMessage(
					{
						customType: "web-search-error",
						content: `Content fetch failed [${fetchId}]: ${message}`,
						display: true,
					},
					{ triggerTurn: false },
				);
			}
		})
		.finally(() => {
			state.pendingFetches.delete(fetchId);
		});
	return fetchId;
}

interface SearchReturnOptions {
	queryList: string[];
	results: QueryResultData[];
	urls: string[];
	includeContent: boolean;
	inlineContent?: ExtractedContent[];
}

function buildSearchReturn(pi: ExtensionAPI, opts: SearchReturnOptions): AgentToolResult<Record<string, unknown>> {
	const sc = opts.results.filter((r) => !r.error).length;
	const tr = opts.results.reduce((sum, r) => sum + r.results.length, 0);

	let output = "";
	for (const { query, answer, results, error } of opts.results) {
		if (opts.queryList.length > 1) {
			output += `## Query: "${query}"\n\n`;
		}
		if (error) output += `Error: ${error}\n\n`;
		else if (results.length === 0) output += "No results found.\n\n";
		else output += `${formatSearchSummary(results, answer)}\n\n`;
	}

	const hasInlineReady = hasFullInlineCoverage(opts.urls, opts.inlineContent);
	let fetchId: string | null = null;
	if (hasInlineReady && opts.inlineContent) {
		fetchId = generateId();
		pi.appendEntry(
			"web-search-results",
			storeFetchedContentResult(fetchId, {
				id: fetchId,
				type: "fetch",
				timestamp: Date.now(),
				urls: sanitizeExtractedContents(opts.inlineContent),
			}),
		);
		output += `---\nFull content for ${opts.inlineContent.length} sources available [${fetchId}].`;
	} else if (opts.includeContent) {
		fetchId = startBackgroundFetch(pi, opts.urls);
		if (fetchId) {
			output += `---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
		}
	}

	const searchId = generateId();
	const searchData: StoredSearchData = {
		id: searchId,
		type: "search",
		timestamp: Date.now(),
		queries: opts.results,
	};
	storeResult(searchId, searchData);
	pi.appendEntry("web-search-results", searchData);

	const isBackgroundFetch = fetchId !== null && !hasInlineReady;

	return {
		// Only when every query failed; a partial failure or an empty result set is not an error.
		...(sc === 0 && opts.queryList.length > 0 ? { isError: true } : {}),
		content: [{ type: "text", text: output.trim() }],
		structuredContent: searchStructuredContent(searchId, fetchId, opts.results),
		details: {
			queries: opts.queryList,
			queryCount: opts.queryList.length,
			successfulQueries: sc,
			totalResults: tr,
			includeContent: opts.includeContent,
			fetchId,
			fetchUrls: isBackgroundFetch ? opts.urls : undefined,
			searchId,
		},
	};
}

export function registerWebSearchTool(pi: ExtensionAPI): void {
	// A call another tool makes (a Pi codemode script) reaches the tool_call handlers with
	// parentToolCallId set, before execute. Such a script wants the finished data, so
	// includeContent waits for the fetch instead of continuing in the background.
	const nestedCallIds = new Set<string>();
	pi.on("tool_call", (event) => {
		if (event.parentToolCallId && event.toolName === "web_search") nestedCallIds.add(event.toolCallId);
	});
	// Ids of calls a later handler blocked never reach execute; drop them with the session.
	pi.on("session_start", () => {
		nestedCallIds.clear();
	});
	pi.on("session_tree", () => {
		nestedCallIds.clear();
	});
	pi.on("session_shutdown", () => {
		nestedCallIds.clear();
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web with Exa (API key or keyless MCP) or, when logged in with a Codex subscription, OpenAI hosted web search (provider: auto/exa/openai). Use queries for multiple searches; includeContent fetches source pages in the background.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description: "One search query.",
				}),
			),
			queries: Type.Optional(
				Type.Array(Type.String(), {
					description: "Multiple search queries, processed in sequence.",
				}),
			),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" })),
			domainFilter: Type.Optional(
				Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" }),
			),
			provider: Type.Optional(
				StringEnum(["auto", "exa", "openai"], {
					description:
						'Search provider (default: auto). auto uses OpenAI first when the current model is a Codex subscription model, then falls back to Exa; otherwise Exa. "openai" needs a Codex /login and uses subscription quota, with no fallback.',
				}),
			),
			category: Type.Optional(
				Type.String({
					description:
						'Restrict results to an Exa category, e.g. "news", "research paper", "pdf", "github", "company". Without an Exa API key it is added to the query text instead.',
				}),
			),
		}),
		outputSchema: webSearchOutputSchema,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const nested = nestedCallIds.delete(toolCallId);
			const rawQueryList: unknown[] = Array.isArray(params.queries)
				? params.queries
				: params.query !== undefined
					? [params.query]
					: [];
			const queryList = normalizeQueryList(rawQueryList);

			if (queryList.length === 0) {
				return {
					isError: true,
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
					details: { error: "No query provided" },
				};
			}

			if (params.provider !== undefined && !isSearchProvider(params.provider)) {
				return {
					isError: true,
					content: [
						{ type: "text", text: `Error: Unknown provider "${String(params.provider)}". Use auto, exa, or openai.` },
					],
					details: { error: "Unknown provider" },
				};
			}

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];
			const allInlineContent: ExtractedContent[] = [];

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];

				onUpdate?.({
					content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results, inlineContent, provider } = await search(
						query,
						{
							provider: params.provider,
							numResults: params.numResults,
							recencyFilter: isRecencyFilter(params.recencyFilter) ? params.recencyFilter : undefined,
							domainFilter: params.domainFilter,
							category:
								typeof params.category === "string" && params.category.trim() ? params.category.trim() : undefined,
							includeContent: params.includeContent,
							signal,
						},
						ctx,
					);

					if (signal?.aborted) break;

					searchResults.push({ query, answer, results, error: null, provider });
					for (const r of results) {
						if (!allUrls.includes(r.url)) {
							allUrls.push(r.url);
						}
					}
					if (inlineContent) allInlineContent.push(...inlineContent);
				} catch (err) {
					if (signal?.aborted) break;
					const message = err instanceof Error ? err.message : String(err);
					searchResults.push({ query, answer: "", results: [], error: message });
				}
			}

			let inlineContent = allInlineContent.length > 0 ? allInlineContent : undefined;
			if (nested && params.includeContent && allUrls.length > 0 && !hasFullInlineCoverage(allUrls, inlineContent)) {
				const { fetchAllContent } = await import("./extract.js");
				const provided = new Map<string, ExtractedContent>();
				for (const content of inlineContent ?? []) {
					if (!provided.has(content.url)) provided.set(content.url, content);
				}
				const missing = allUrls.filter((url) => !provided.has(url));
				const fetched = await fetchAllContent(missing, signal);
				signal?.throwIfAborted();
				for (const content of fetched) provided.set(content.url, content);
				inlineContent = stripThumbnails(allUrls.flatMap((url) => provided.get(url) ?? []));
			}

			return buildSearchReturn(pi, {
				queryList,
				results: searchResults,
				urls: allUrls,
				includeContent: params.includeContent ?? false,
				inlineContent,
			});
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const rawQueryList: unknown[] = Array.isArray(input.queries)
				? input.queries
				: input.query !== undefined
					? [input.query]
					: [];
			const queryList = normalizeQueryList(rawQueryList);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? `${q.slice(0, 57)}...` : q;
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? `${q.slice(0, 47)}...` : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			type QueryDetail = {
				query: string;
				provider: string | null;
				answer: string | null;
				sources: Array<{ title: string; url: string }>;
				error: string | null;
			};
			// curated/summary fields remain readable so entries from old sessions render correctly.
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				fetchId?: string;
				fetchUrls?: string[];
				phase?: string;
				progress?: number;
				currentQuery?: string;
				curated?: boolean;
				curatedFrom?: number;
				curatedQueries?: QueryDetail[];
				cancelled?: boolean;
				cancelReason?: string;
				summary?: {
					text: string;
					workflow: string;
					model: string | null;
					durationMs: number;
					tokenEstimate: number;
					fallbackUsed: boolean;
					fallbackReason?: string;
					edited?: boolean;
				};
			};

			if (isPartial) {
				if (details?.phase === "searching" || details?.phase === "search") {
					const progress = details?.progress ?? 0;
					const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
					const query = details?.currentQuery || "";
					const display = query.length > 40 ? `${query.slice(0, 37)}...` : query;
					return new Text(theme.fg("accent", `[${bar}] ${display}`), 0, 0);
				}
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "searching"}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			const queryInfo =
				details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
			if (details?.curated && details?.curatedFrom) {
				statusLine += theme.fg("muted", ` (${details.queryCount}/${details.curatedFrom} queries curated)`);
			}
			if (details?.fetchId && details?.fetchUrls) {
				statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
			} else if (details?.fetchId) {
				statusLine += theme.fg("muted", " (content ready)");
			}

			// Build expanded lines first so collapsed view can reference total count
			const lines = [statusLine];
			if (details?.summary?.text) {
				lines.push("");
				lines.push(theme.fg("accent", `── Summary (${details.summary.workflow}) ${"─".repeat(32)}`));
				lines.push("");
				for (const line of details.summary.text.split("\n")) {
					lines.push(`  ${line}`);
				}
				lines.push("");
				const metaParts = [
					details.summary.model ? `model=${details.summary.model}` : "model=deterministic",
					`duration=${details.summary.durationMs}ms`,
					`tokens~${details.summary.tokenEstimate}`,
					details.summary.fallbackUsed ? "fallback=true" : "fallback=false",
					details.summary.edited ? "edited=true" : "edited=false",
				];
				if (details.summary.fallbackReason) {
					metaParts.push(`reason=${details.summary.fallbackReason}`);
				}
				lines.push(theme.fg("dim", `  ${metaParts.join(" · ")}`));
			}

			const queryDetails = details?.curatedQueries;
			if (queryDetails?.length) {
				const kept = queryDetails.length;
				const from = details?.curatedFrom ?? kept;
				lines.push("");
				lines.push(
					theme.fg("accent", `\u2500\u2500 Curated Results (${kept} of ${from} queries kept) ${"\u2500".repeat(24)}`),
				);

				for (const cq of queryDetails) {
					lines.push("");
					const dq = cq.query.length > 65 ? `${cq.query.slice(0, 62)}...` : cq.query;
					const providerLabel = cq.provider ? ` (${cq.provider})` : "";
					lines.push(theme.fg("accent", `  "${dq}"${providerLabel}`));

					if (cq.error) {
						lines.push(theme.fg("error", `  ${cq.error}`));
					} else if (cq.answer) {
						lines.push("");
						for (const line of cq.answer.split("\n")) {
							lines.push(`  ${line}`);
						}
					}

					if (cq.sources.length > 0) {
						lines.push("");
						for (const s of cq.sources) {
							const domain = s.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
							const title = s.title.length > 50 ? `${s.title.slice(0, 47)}...` : s.title;
							lines.push(theme.fg("muted", `  \u25b8 ${title}`) + theme.fg("dim", ` \u00b7 ${domain}`));
						}
					}
				}
				lines.push("");
			} else {
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				const preview = textContent.length > 500 ? `${textContent.slice(0, 500)}...` : textContent;
				for (const line of preview.split("\n")) {
					lines.push(theme.fg("dim", line));
				}
			}

			if (details?.fetchUrls && details.fetchUrls.length > 0) {
				lines.push(theme.fg("muted", "Fetching:"));
				for (const u of details.fetchUrls.slice(0, 5)) {
					const display = u.length > 60 ? `${u.slice(0, 57)}...` : u;
					lines.push(theme.fg("dim", `  ${display}`));
				}
				if (details.fetchUrls.length > 5) {
					lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
				}
			}

			const totalLines = lines.length;

			if (!expanded) {
				const box = new Box(1, 0, (t) => theme.bg("toolSuccessBg", t));
				box.addChild(new Text(statusLine, 0, 0));

				let collapsedLines = 1; // statusLine
				const summaryPreview = details?.summary?.text?.trim() || "";
				if (summaryPreview) {
					const preview = summaryPreview.length > 120 ? `${summaryPreview.slice(0, 117)}...` : summaryPreview;
					box.addChild(new Text(theme.fg("dim", preview), 0, 0));
					collapsedLines++;
				} else if (details?.curatedQueries?.length) {
					for (const cq of details.curatedQueries.slice(0, 3)) {
						const dq = cq.query.length > 55 ? `${cq.query.slice(0, 52)}...` : cq.query;
						const srcCount = cq.sources?.length ?? 0;
						const suffix = cq.error ? theme.fg("error", " (error)") : theme.fg("dim", ` · ${srcCount} sources`);
						box.addChild(new Text(theme.fg("accent", `  "${dq}"`) + suffix, 0, 0));
						collapsedLines++;
					}
					if (details.curatedQueries.length > 3) {
						box.addChild(new Text(theme.fg("dim", `  ... and ${details.curatedQueries.length - 3} more`), 0, 0));
						collapsedLines++;
					}
				} else {
					const textContent = result.content.find((c) => c.type === "text")?.text || "";
					const firstContentLine = textContent.split("\n").find((l) => {
						const t = l.trim();
						return t && !t.startsWith("[") && !t.startsWith("#") && !t.startsWith("---");
					});
					const fallbackLine = (firstContentLine?.trim() || "").replace(/\*\*/g, "");
					if (fallbackLine) {
						const preview = fallbackLine.length > 120 ? `${fallbackLine.slice(0, 117)}...` : fallbackLine;
						box.addChild(new Text(theme.fg("dim", preview), 0, 0));
						collapsedLines++;
					}
				}
				const moreLines = Math.max(0, totalLines - collapsedLines);
				if (moreLines > 0) {
					box.addChild(
						new Text(theme.fg("muted", `\n... (${moreLines} more lines, ${totalLines} total, ctrl+o to expand)`), 0, 0),
					);
				}
				return box;
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
