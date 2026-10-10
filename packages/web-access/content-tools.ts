import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type FindMode, findContent } from "./content-find.js";
import type { ExtractedContent } from "./extract.js";
import { formatFullResults, stripThumbnails } from "./result-format.js";
import { generateId, getResult, type QueryResultData, storeFetchedContentResult } from "./storage.js";
import { formatSeconds } from "./utils.js";

const MAX_INLINE_CONTENT = 30000;

// Shape of `structuredContent`, the data a Pi codemode script receives instead of the text output.
const fetchContentOutputSchema = Type.Object({
	responseId: Type.Union([Type.String(), Type.Null()], { description: "Id of the stored content" }),
	urls: Type.Array(
		Type.Object({
			url: Type.String(),
			title: Type.String(),
			content: Type.String({ description: "Full extracted content, not limited by the inline character cap" }),
			error: Type.Union([Type.String(), Type.Null()], { description: "Why this URL failed, null on success" }),
			duration: Type.Optional(Type.Number()),
		}),
	),
});

function fetchStructuredContent(responseId: string, results: ExtractedContent[]) {
	return {
		responseId,
		urls: results.map(({ url, title, content, error, duration }) => ({
			url,
			title,
			content,
			error,
			...(duration !== undefined ? { duration } : {}),
		})),
	};
}
const textContent = (text: string): TextContent => ({ type: "text", text });
const imageContent = (data: string, mimeType: string): ImageContent => ({ type: "image", data, mimeType });
export function registerContentTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description:
			'Extract text from web pages, GitHub, and PDFs. YouTube and local videos support frames only (timestamp/frames), not transcripts. Use mode: "raw" for the exact text body of an HTTP(S) URL (JSON, XML, plain text, source files) without readability extraction. Use get_search_content for full stored results.',
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
			mode: Type.Optional(
				Type.Union([Type.Literal("readable"), Type.Literal("raw")], {
					description:
						'"readable" (default) extracts the main content as markdown. "raw" returns the exact text response body of an HTTP(S) URL (up to 5MB, text types only) and ignores timestamp/frames.',
				}),
			),
			timestamp: Type.Optional(
				Type.String({
					description:
						"Video frame time (seconds, MM:SS, or H:MM:SS) or range (start-end). A range extracts up to 6 frames by default; frames sets the count. Requires ffmpeg and yt-dlp for YouTube.",
				}),
			),
			frames: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 12,
					description:
						"Sample 1–12 video frames. Without timestamp, samples the full video; with a single time, samples at 5-second intervals.",
				}),
			),
		}),

		outputSchema: fetchContentOutputSchema,

		async execute(_toolCallId, params, signal, onUpdate) {
			const urlList = params.urls ?? (params.url ? [params.url] : []);
			if (urlList.length === 0) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Error: No URL provided. Use the 'url' parameter, or 'urls' for parallel fetches.",
						},
					],
					details: { error: "No URL provided" },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});

			// Heavy extract module graph loads on first fetch.
			const { fetchAllContent } = await import("./extract.js");
			const fetchResults = await fetchAllContent(urlList, signal, {
				timestamp: params.timestamp,
				frames: params.frames,
				mode: params.mode,
			});
			const successful = fetchResults.filter((r) => !r.error).length;
			const totalChars = fetchResults.reduce((sum, r) => sum + r.content.length, 0);

			// ALWAYS store results (even for single URL)
			const responseId = generateId();
			pi.appendEntry(
				"web-search-results",
				storeFetchedContentResult(responseId, {
					id: responseId,
					type: "fetch",
					timestamp: Date.now(),
					urls: stripThumbnails(fetchResults),
				}),
			);

			const structuredContent = fetchStructuredContent(responseId, fetchResults);

			// Single URL: return content directly (possibly truncated) with responseId
			if (urlList.length === 1) {
				const result = fetchResults[0];
				if (result.error) {
					return {
						isError: true,
						content: [{ type: "text", text: `Error: ${result.error}` }],
						structuredContent,
						details: {
							urls: urlList,
							urlCount: 1,
							successful: 0,
							error: result.error,
							responseId,
							timestamp: params.timestamp,
							frames: params.frames,
						},
					};
				}

				const fullLength = result.content.length;
				const truncated = fullLength > MAX_INLINE_CONTENT;
				let output = truncated
					? `${result.content.slice(0, MAX_INLINE_CONTENT)}\n\n[Content truncated...]`
					: result.content;

				if (truncated) {
					output +=
						`\n\n---\nShowing ${MAX_INLINE_CONTENT} of ${fullLength} chars. ` +
						`Use get_search_content({ responseId: "${responseId}", urlIndex: 0 }) for full content.`;
				}

				const content: Array<TextContent | ImageContent> = [];
				if (result.frames?.length) {
					for (const frame of result.frames) {
						content.push(imageContent(frame.data, frame.mimeType));
						content.push(textContent(`Frame at ${frame.timestamp}`));
					}
				} else if (result.thumbnail) {
					content.push(imageContent(result.thumbnail.data, result.thumbnail.mimeType));
				}
				content.push(textContent(output));

				const imageCount = (result.frames?.length ?? 0) + (result.thumbnail ? 1 : 0);
				return {
					content,
					structuredContent,
					details: {
						urls: urlList,
						urlCount: 1,
						successful: 1,
						totalChars: fullLength,
						title: result.title,
						responseId,
						truncated,
						hasImage: imageCount > 0,
						imageCount,
						timestamp: params.timestamp,
						frames: params.frames,
						duration: result.duration,
					},
				};
			}

			// Multi-URL: existing behavior (summary + responseId)
			let output = "## Fetched URLs\n\n";
			for (const { url, title, content, error } of fetchResults) {
				if (error) {
					output += `- ${url}: Error - ${error}\n`;
				} else {
					output += `- ${title || url} (${content.length} chars)\n`;
				}
			}
			output += `\n---\nUse get_search_content({ responseId: "${responseId}", urlIndex: 0 }) to retrieve full content.`;

			return {
				...(successful === 0 ? { isError: true } : {}),
				content: [{ type: "text", text: output }],
				structuredContent,
				details: { urls: urlList, urlCount: urlList.length, successful, totalChars, responseId },
			};
		},

		renderCall(args, theme) {
			const { url, urls, timestamp, frames } = args as {
				url?: string;
				urls?: string[];
				timestamp?: string;
				frames?: number;
			};
			const urlList = urls ?? (url ? [url] : []);
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			const lines: string[] = [];
			if (urlList.length === 1) {
				const display = urlList[0].length > 60 ? `${urlList[0].slice(0, 57)}...` : urlList[0];
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			} else {
				lines.push(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`));
				for (const u of urlList.slice(0, 5)) {
					const display = u.length > 60 ? `${u.slice(0, 57)}...` : u;
					lines.push(theme.fg("muted", `  ${display}`));
				}
				if (urlList.length > 5) {
					lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
				}
			}
			if (timestamp) {
				lines.push(theme.fg("dim", "  timestamp: ") + theme.fg("warning", timestamp));
			}
			if (typeof frames === "number") {
				lines.push(theme.fg("dim", "  frames: ") + theme.fg("warning", String(frames)));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
				truncated?: boolean;
				responseId?: string;
				phase?: string;
				progress?: number;
				hasImage?: boolean;
				imageCount?: number;
				timestamp?: string;
				frames?: number;
				duration?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "fetching"}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				const imgCount = details?.imageCount ?? (details?.hasImage ? 1 : 0);
				const imageBadge =
					imgCount > 1
						? theme.fg("accent", ` [${imgCount} images]`)
						: imgCount === 1
							? theme.fg("accent", " [image]")
							: "";
				let statusLine =
					theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`) + imageBadge;
				if (details?.truncated) {
					statusLine += theme.fg("warning", " [truncated]");
				}
				if (typeof details?.duration === "number") {
					statusLine += theme.fg("muted", ` | ${formatSeconds(Math.floor(details.duration))} total`);
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				if (!expanded) {
					const brief = textContent.length > 200 ? `${textContent.slice(0, 200)}...` : textContent;
					return new Text(`${statusLine}\n${theme.fg("dim", brief)}`, 0, 0);
				}
				const lines = [statusLine];
				if (details?.timestamp) {
					lines.push(theme.fg("dim", `  timestamp: ${details.timestamp}`));
				}
				if (typeof details?.frames === "number") {
					lines.push(theme.fg("dim", `  frames: ${details.frames}`));
				}
				const preview = textContent.length > 500 ? `${textContent.slice(0, 500)}...` : textContent;
				lines.push(theme.fg("dim", preview));
				return new Text(lines.join("\n"), 0, 0);
			}

			const countColor = (details?.successful ?? 0) > 0 ? "success" : "error";
			const statusLine =
				theme.fg(countColor, `${details?.successful}/${details?.urlCount} URLs`) +
				theme.fg("muted", " (content stored)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? `${textContent.slice(0, 500)}...` : textContent;
			return new Text(`${statusLine}\n${theme.fg("dim", preview)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description:
			"Retrieve full stored content, a bounded slice (offset/limit), or matching passages (findText) from a previous web_search or fetch_content call. Use findText to locate passages without paging through a long page.",
		promptSnippet:
			"Use after web_search or fetch_content to retrieve stored content via responseId. Use findText to locate passages without paging through the full content.",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
			query: Type.Optional(Type.String({ description: "Get content for this query (web_search)" })),
			queryIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Get content for URL at index" })),
			offset: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: "Character offset in the stored content (default 0). Cannot be combined with findText.",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_INLINE_CONTENT,
					description: `Maximum characters to return (default and max ${MAX_INLINE_CONTENT}). Cannot be combined with findText.`,
				}),
			),
			findText: Type.Optional(
				Type.Union(
					[
						Type.String({ minLength: 1, maxLength: 500 }),
						Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
					],
					{
						description:
							"Text or texts to find in the selected stored content. Returns matches with surrounding context (max 20,000 chars). Cannot be combined with offset or limit.",
					},
				),
			),
			findMode: Type.Optional(
				Type.Union([Type.Literal("exact"), Type.Literal("case-insensitive"), Type.Literal("fuzzy")], {
					description: "Matching mode for findText (default: case-insensitive). Requires findText.",
				}),
			),
		}),

		async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
			const data = getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for "${params.responseId}"` }],
					isError: true,
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			const argError = validateContentArgs(params);
			if (argError) {
				return {
					content: [{ type: "text", text: argError }],
					isError: true,
					details: { error: argError },
				};
			}

			if (data.type === "search" && data.queries) {
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = data.queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = data.queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query "${params.query}" not found. Available: ${available}` }],
							isError: true,
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = data.queries[params.queryIndex];
					if (!queryData) {
						return {
							content: [
								{ type: "text", text: `Index ${params.queryIndex} out of range (0-${data.queries.length - 1})` },
							],
							isError: true,
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex. Available: ${available}` }],
						isError: true,
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error for "${queryData.query}": ${queryData.error}` }],
						isError: true,
						details: { error: queryData.error, query: queryData.query },
					};
				}

				const selectedQueryIndex = data.queries.indexOf(queryData);
				return selectContent(
					formatFullResults(queryData),
					params,
					{ query: queryData.query, resultCount: queryData.results.length },
					"",
					`queryIndex: ${selectedQueryIndex}`,
				);
			}

			if (data.type === "fetch" && data.urls) {
				let urlData: ExtractedContent | undefined;
				let selectedUrlIndex = -1;

				if (params.url !== undefined) {
					selectedUrlIndex = data.urls.findIndex((u) => u.url === params.url);
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						const available = data.urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL not found. Available:\n  ${available}` }],
							isError: true,
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					selectedUrlIndex = params.urlIndex;
					urlData = data.urls[selectedUrlIndex];
					if (!urlData) {
						return {
							content: [{ type: "text", text: `Index ${params.urlIndex} out of range (0-${data.urls.length - 1})` }],
							isError: true,
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex. Available:\n  ${available}` }],
						isError: true,
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error for ${urlData.url}: ${urlData.error}` }],
						isError: true,
						details: { error: urlData.error, url: urlData.url },
					};
				}

				return selectContent(
					urlData.content,
					params,
					{ url: urlData.url, title: urlData.title },
					`# ${urlData.title}\n\n`,
					`urlIndex: ${selectedUrlIndex}`,
				);
			}

			return {
				content: [{ type: "text", text: "Invalid stored data format" }],
				isError: true,
				details: { error: "Invalid data" },
			};
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex, offset, findText } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
				offset?: number;
				findText?: string | string[];
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? `${url.slice(0, 27)}...` : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			if (offset !== undefined) target += target ? ` @ ${offset}` : `offset=${offset}`;
			if (findText !== undefined) {
				const count = Array.isArray(findText) ? findText.length : 1;
				target += `${target ? " | " : ""}find ${count}`;
			}
			return new Text(
				theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || responseId.slice(0, 8)),
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				error?: string;
				query?: string;
				url?: string;
				title?: string;
				resultCount?: number;
				contentLength?: number;
				offset?: number;
				returnedChars?: number;
				nextOffset?: number | null;
				matchCount?: number;
				returnedMatches?: number;
			};

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			if (typeof details?.matchCount === "number") {
				statusLine =
					theme.fg("success", details.title || details.query || "Content") +
					theme.fg("muted", ` (${details.matchCount} matches, ${details.returnedMatches ?? 0} shown)`);
			} else if (details?.query) {
				const start = details.offset ?? 0;
				const slice =
					details.nextOffset !== undefined && (details.nextOffset !== null || start > 0)
						? `, showing ${start}-${start + (details.returnedChars ?? 0)}`
						: "";
				statusLine =
					theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount} results${slice})`);
			} else {
				const start = details?.offset ?? 0;
				const slice =
					details?.nextOffset !== undefined && (details.nextOffset !== null || start > 0)
						? `, showing ${start}-${start + (details.returnedChars ?? 0)}`
						: "";
				statusLine =
					theme.fg("success", details?.title || "Content") +
					theme.fg("muted", ` (${details?.contentLength ?? 0} chars${slice})`);
			}

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? `${textContent.slice(0, 500)}...` : textContent;
			return new Text(`${statusLine}\n${theme.fg("dim", preview)}`, 0, 0);
		},
	});
}

type ContentArgs = {
	responseId: string;
	offset?: number;
	limit?: number;
	findText?: string | string[];
	findMode?: FindMode;
};

function normalizeFindQueries(value: string | string[]): string[] {
	return (Array.isArray(value) ? value : [value]).map((q) => q.trim()).filter(Boolean);
}

function validateContentArgs(params: ContentArgs): string | null {
	if (params.findText === undefined) {
		if (params.findMode !== undefined) return "findMode requires findText; provide findText or omit findMode.";
		return null;
	}
	if (params.offset !== undefined || params.limit !== undefined) {
		return "findText cannot be combined with offset or limit. Use findText to locate passages, or offset/limit to page through content.";
	}
	if (normalizeFindQueries(params.findText).length === 0) {
		return "findText must contain at least one non-empty string.";
	}
	return null;
}

/** Returns the findText matches or the requested offset/limit slice of stored text. */
function selectContent(
	full: string,
	params: ContentArgs,
	meta: Record<string, unknown>,
	heading: string,
	nextTarget: string,
): AgentToolResult<Record<string, unknown>> {
	if (params.findText !== undefined) {
		const findMode = params.findMode ?? "case-insensitive";
		const { text, ...found } = findContent(full, normalizeFindQueries(params.findText), findMode);
		return {
			content: [{ type: "text", text: `${heading}${text}` }],
			details: { ...meta, contentLength: full.length, findMode, ...found },
		};
	}

	const offset = params.offset ?? 0;
	const limit = params.limit ?? MAX_INLINE_CONTENT;
	if (offset > full.length) {
		const error = `Offset ${offset} is out of range; valid range is 0-${full.length}.`;
		return {
			content: [{ type: "text", text: error }],
			isError: true,
			details: { error, contentLength: full.length },
		};
	}

	const end = Math.min(offset + limit, full.length);
	const hasMore = end < full.length;
	let text = `${heading}${full.slice(offset, end)}`;
	if (hasMore || offset > 0) {
		text += `\n\n---\nShowing chars ${offset}-${end} of ${full.length}.`;
		if (hasMore) {
			text += ` Use get_search_content({ responseId: "${params.responseId}", ${nextTarget}, offset: ${end}, limit: ${limit} }) for the next slice.`;
		}
	}
	return {
		content: [{ type: "text", text }],
		details: {
			...meta,
			contentLength: full.length,
			offset,
			limit,
			returnedChars: end - offset,
			nextOffset: hasMore ? end : null,
			truncated: hasMore,
		},
	};
}
