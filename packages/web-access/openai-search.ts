import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityMonitor } from "./activity.js";
import { loadConfigSection } from "./config.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./search-types.js";

/**
 * Hosted `web_search` through the ChatGPT (Codex) subscription login. Only the OAuth
 * credential Pi stores for `openai-codex` is used, and it is only ever sent to the Codex
 * endpoint below. There is no API key path.
 */
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_PROVIDER = "openai-codex";
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULTS = 20;
const MAX_DOMAINS = 100;

// The selected model runs the server-side web_search call and writes the cited summary.
// Prefer the newest low-cost ("luna") model, then the newest bare mainline id, then any
// other versioned GPT id. Price tiers ("pro"/"ultra" id segments) are excluded, and the
// numeric-aware sort keeps e.g. gpt-5.10 ahead of gpt-5.9.
const EXCLUDED_MODEL_SEGMENTS = new Set(["pro", "ultra"]);
const MODEL_PREFERENCE = [
	(id: string) => id.includes("luna"),
	(id: string) => /^gpt-\d+(\.\d+)?$/.test(id),
	(id: string) => /^gpt-\d/.test(id),
];

export type OpenAISearchContext = Pick<ExtensionContext, "model" | "modelRegistry">;

export interface OpenAISearchAuth {
	apiKey: string;
	model: string;
	headers: Record<string, string>;
}

interface OpenAIConfig {
	searchModel: string | null;
}

function loadOpenAIConfig(): OpenAIConfig {
	return loadConfigSection("openai", { searchModel: null }, (raw) => {
		const value = raw.openaiSearchModel;
		if (value == null) return { searchModel: null };
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new Error("openaiSearchModel in ~/.pi/web-search.json must be a non-empty string");
		}
		return { searchModel: value.trim() };
	});
}

export function pickSearchModel<T extends { id: string }>(models: readonly T[]): T | undefined {
	const candidates = models
		.filter((model) => !model.id.split("-").some((segment) => EXCLUDED_MODEL_SEGMENTS.has(segment)))
		.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
	for (const prefers of MODEL_PREFERENCE) {
		const preferred = candidates.find((model) => prefers(model.id));
		if (preferred) return preferred;
	}
	return candidates[0];
}

/** The active model draws on the ChatGPT (Codex) subscription. */
export function isOpenAISubscriptionModelSelected(ctx?: Pick<ExtensionContext, "model">): boolean {
	return ctx?.model?.provider === CODEX_PROVIDER;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const padded = parts[1]
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
		const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function extractAccountId(token: string): string | undefined {
	const auth = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object") return undefined;
	const id = (auth as Record<string, unknown>).chatgpt_account_id;
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

function redact(text: string, credential: string): string {
	return credential ? text.split(credential).join("[redacted]") : text;
}

/** Look up the logged-in Codex credential; undefined when `/login` was never done for it. */
export async function resolveOpenAIAuth(ctx?: OpenAISearchContext): Promise<OpenAISearchAuth | undefined> {
	if (!ctx) return undefined;
	let models: ReturnType<typeof ctx.modelRegistry.getAll>;
	try {
		models = ctx.modelRegistry.getAll();
	} catch {
		return undefined;
	}
	const preferred = pickSearchModel(models.filter((model) => model.provider === CODEX_PROVIDER));
	if (!preferred) return undefined;
	let resolved: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>>;
	try {
		resolved = await ctx.modelRegistry.getApiKeyAndHeaders(preferred);
	} catch {
		return undefined;
	}
	if (!resolved.ok || !resolved.apiKey) return undefined;
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(resolved.headers ?? {})) {
		if (value !== null && value !== undefined) headers[name] = value;
	}
	return { apiKey: resolved.apiKey, model: loadOpenAIConfig().searchModel ?? preferred.id, headers };
}

export async function isOpenAISearchAvailable(ctx?: OpenAISearchContext): Promise<boolean> {
	return (await resolveOpenAIAuth(ctx)) !== undefined;
}

// ─── Request ─────────────────────────────────────────────────────────────────

function normalizeDomain(value: string): string | null {
	let input = value.trim().toLowerCase();
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return null;
	try {
		input = (input.includes("://") ? new URL(input) : new URL(`https://${input}`)).hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

function normalizeDomainFilters(
	domainFilter: string[] | undefined,
): { allowedDomains?: string[]; blockedDomains?: string[] } | null {
	if (!domainFilter?.length) return null;
	const allowed: string[] = [];
	const blocked: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blocked : allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	if (allowed.length === 0 && blocked.length === 0) return null;
	return {
		...(allowed.length > 0 ? { allowedDomains: allowed.slice(0, MAX_DOMAINS) } : {}),
		...(blocked.length > 0 ? { blockedDomains: blocked.slice(0, MAX_DOMAINS) } : {}),
	};
}

const RECENCY_LABELS = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };

function buildInstructions(options: SearchOptions): string {
	const lines = [
		"Search the web and return a concise answer grounded only in the web results.",
		"Include clickable source citations in the response text when possible.",
	];
	if (options.recencyFilter) lines.push(`Prefer sources from the ${RECENCY_LABELS[options.recencyFilter]}.`);
	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
		lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), MAX_RESULTS)} distinct sources.`);
	}
	if (options.category) lines.push(`Focus on ${options.category} sources.`);
	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters?.allowedDomains?.length) lines.push(`Only use sources from: ${filters.allowedDomains.join(", ")}.`);
	if (filters?.blockedDomains?.length) lines.push(`Do not use sources from: ${filters.blockedDomains.join(", ")}.`);
	return lines.join(" ");
}

function buildWebSearchTool(options: SearchOptions): Record<string, unknown> {
	const tool: Record<string, unknown> = { type: "web_search" };
	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters) {
		tool.filters = {
			...(filters.allowedDomains ? { allowed_domains: filters.allowedDomains } : {}),
			...(filters.blockedDomains ? { blocked_domains: filters.blockedDomains } : {}),
		};
	}
	return tool;
}

// ─── Response parsing ────────────────────────────────────────────────────────

interface ParsedOpenAIResponse {
	payload: Record<string, unknown>;
	webSearchCallSeen: boolean;
}

type StreamError = { code?: unknown; type?: unknown; message?: unknown };

function isWebSearchCall(item: unknown): boolean {
	return !!item && typeof item === "object" && (item as { type?: unknown }).type === "web_search_call";
}

async function parseOpenAIResponse(response: Response): Promise<ParsedOpenAIResponse> {
	const text = await response.text();
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			const payload = Array.isArray(parsed)
				? { output: parsed }
				: parsed && typeof parsed === "object"
					? (parsed as Record<string, unknown>)
					: { output: [] };
			const output = Array.isArray(payload.output) ? payload.output : [];
			return { payload, webSearchCallSeen: output.some(isWebSearchCall) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`OpenAI API returned invalid JSON: ${message}`);
		}
	}

	const outputItems: unknown[] = [];
	let completedResponse: Record<string, unknown> | null = null;
	let webSearchCallSeen = false;
	let streamError: StreamError | null = null;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(data) as Record<string, unknown>;
		} catch {
			continue;
		}
		// The API can fail mid-stream with HTTP 200: a terminal `error` event or
		// `response.failed` carries the real error (e.g. quota exhaustion) and no output.
		if (parsed.type === "error") {
			const err = parsed.error;
			streamError ??=
				err && typeof err === "object"
					? (err as StreamError)
					: {
							code: parsed.code,
							message: typeof err === "string" ? err : typeof parsed.message === "string" ? parsed.message : undefined,
						};
		}
		if (typeof parsed.type === "string" && parsed.type.startsWith("response.web_search_call")) webSearchCallSeen = true;
		if (parsed.type === "response.output_item.done" && parsed.item) {
			outputItems.push(parsed.item);
			webSearchCallSeen ||= isWebSearchCall(parsed.item);
		}
		if (
			(parsed.type === "response.failed" ||
				parsed.type === "response.incomplete" ||
				parsed.type === "response.done" ||
				parsed.type === "response.completed") &&
			parsed.response &&
			typeof parsed.response === "object"
		) {
			completedResponse = parsed.response as Record<string, unknown>;
			const responseError = completedResponse.error;
			if (responseError && typeof responseError === "object") streamError ??= responseError as StreamError;
			// A failed response can carry `error: null`; its partial output must not pass as success.
			if (parsed.type === "response.failed") {
				streamError ??= { message: "response stream failed with no error payload (invalid response)" };
			}
		}
	}

	if (streamError) {
		const code = typeof streamError.code === "string" ? streamError.code : undefined;
		const type = typeof streamError.type === "string" ? streamError.type : undefined;
		const message =
			typeof streamError.message === "string" && streamError.message.trim().length > 0
				? streamError.message
				: "OpenAI API stream failed";
		const detail = [type, code].filter(Boolean).join("/");
		throw new Error(`OpenAI API stream error${detail ? ` (${detail})` : ""}: ${message}`);
	}

	if (completedResponse) {
		const output = Array.isArray(completedResponse.output) ? completedResponse.output : [];
		const payload = output.length > 0 ? completedResponse : { ...completedResponse, output: outputItems };
		return { payload, webSearchCallSeen: webSearchCallSeen || output.some(isWebSearchCall) };
	}
	if (outputItems.length > 0) {
		return {
			payload: { output: outputItems },
			webSearchCallSeen: webSearchCallSeen || outputItems.some(isWebSearchCall),
		};
	}
	throw new Error("OpenAI API returned no parseable response output");
}

function cleanSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
		return url.toString();
	} catch {
		return rawUrl.replace(/[?&]utm_source=openai$/, "");
	}
}

function extractSnippetAround(text: string, start: unknown, end: unknown): string {
	if (typeof start !== "number" || typeof end !== "number" || !text) return "";
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text
		.slice(before, after)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function addResult(results: SearchResult[], seen: Set<string>, url: unknown, title: unknown, snippet = ""): void {
	if (typeof url !== "string" || url.trim().length === 0) return;
	const cleanUrl = cleanSourceUrl(url);
	if (seen.has(cleanUrl)) return;
	seen.add(cleanUrl);
	results.push({
		title: typeof title === "string" && title.trim().length > 0 ? title : cleanUrl,
		url: cleanUrl,
		snippet,
	});
}

function messageParts(output: unknown[]): Record<string, unknown>[] {
	const parts: Record<string, unknown>[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part && typeof part === "object") parts.push(part as Record<string, unknown>);
		}
	}
	return parts;
}

function extractSearchResults(output: unknown[], numResults: number | undefined): SearchResult[] {
	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();

	for (const part of messageParts(output)) {
		const text = typeof part.text === "string" ? part.text : "";
		if (!Array.isArray(part.annotations)) continue;
		for (const annotation of part.annotations) {
			if (!annotation || typeof annotation !== "object" || annotation.type !== "url_citation") continue;
			addResult(
				results,
				seenUrls,
				annotation.url,
				annotation.title,
				extractSnippetAround(text, annotation.start_index, annotation.end_index),
			);
		}
	}

	for (const item of output) {
		if (!isWebSearchCall(item)) continue;
		const value = item as { action?: unknown; sources?: unknown; results?: unknown };
		const actionSources =
			value.action && typeof value.action === "object" ? (value.action as { sources?: unknown }).sources : undefined;
		for (const group of [actionSources, value.sources, value.results]) {
			if (!Array.isArray(group)) continue;
			for (const source of group) {
				if (!source || typeof source !== "object") continue;
				const record = source as Record<string, unknown>;
				addResult(results, seenUrls, record.url ?? record.source_website_url, record.title ?? record.caption);
			}
		}
	}

	if (typeof numResults === "number" && Number.isFinite(numResults) && numResults > 0) {
		return results.slice(0, Math.min(Math.floor(numResults), MAX_RESULTS));
	}
	return results;
}

function extractAnswer(output: unknown[]): string {
	const parts: string[] = [];
	for (const part of messageParts(output)) {
		if (typeof part.text === "string" && part.text.trim().length > 0) parts.push(part.text);
	}
	return parts.join("\n").trim();
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function runOpenAISearch(query: string, options: SearchOptions, auth: OpenAISearchAuth): Promise<SearchResponse> {
	const body = {
		model: auth.model,
		instructions: buildInstructions(options),
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [buildWebSearchTool(options)],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "required",
		parallel_tool_calls: true,
	};
	const headers: Record<string, string> = {
		...auth.headers,
		Authorization: `Bearer ${auth.apiKey}`,
		"Content-Type": "application/json",
		"OpenAI-Beta": "responses=experimental",
		originator: "pi",
	};
	const accountId = extractAccountId(auth.apiKey);
	if (accountId) headers["chatgpt-account-id"] = accountId;

	options.signal?.throwIfAborted();
	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
		const response = await fetch(CODEX_RESPONSES_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			// The credential must never follow a redirect to another host.
			redirect: "error",
			signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
		});

		if (!response.ok) {
			const errorText = redact(await response.text(), auth.apiKey);
			throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const parsed = await parseOpenAIResponse(response);
		const output = Array.isArray(parsed.payload.output) ? parsed.payload.output : [];
		if (!parsed.webSearchCallSeen) throw new Error("OpenAI web_search returned no web_search_call");
		const answer = extractAnswer(output);
		const results = extractSearchResults(output, options.numResults);
		if (!answer && results.length === 0) throw new Error("OpenAI web_search returned no answer or sources");

		activityMonitor.logComplete(activityId, response.status);
		return { answer, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const redacted = redact(message, auth.apiKey);
		if (options.signal?.aborted) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redacted);
		if (redacted === message) throw err;
		const redactedError = new Error(redacted);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}

export const OPENAI_LOGIN_REQUIRED_MESSAGE =
	"OpenAI web search unavailable. Sign in with a Codex (ChatGPT) subscription using /login.";

export async function searchWithOpenAI(
	query: string,
	options: SearchOptions = {},
	ctx?: OpenAISearchContext,
): Promise<SearchResponse> {
	const auth = await resolveOpenAIAuth(ctx);
	if (!auth) throw new Error(OPENAI_LOGIN_REQUIRED_MESSAGE);
	return runOpenAISearch(query, options, auth);
}
