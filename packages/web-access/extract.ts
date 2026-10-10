import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import pLimit from "p-limit";
import TurndownService from "turndown";
import { activityMonitor } from "./activity.js";
import { sanitizeExtractedContents } from "./data-uri-sanitize.js";
import { extractGitHub } from "./github-extract.js";
import { extractPDFToMarkdown, isPDF } from "./pdf-extract.js";
import { extractRSCContent } from "./rsc-extract.js";
import { formatSeconds } from "./utils.js";
import { extractVideoFrame, getLocalVideoDuration, isVideoFile } from "./video-extract.js";
import { extractYouTubeFrame, extractYouTubeFrames, getYouTubeStreamInfo, isYouTubeURL } from "./youtube-extract.js";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large"];
const MIN_USEFUL_CONTENT = 500;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isConfigParseError(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface VideoFrame {
	data: string;
	mimeType: string;
	timestamp: string;
}

export type FrameData = { data: string; mimeType: string };
export type FrameResult = FrameData | { error: string };

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	frames?: VideoFrame[];
	duration?: number;
}

export type FetchMode = "readable" | "raw";

export interface ExtractOptions {
	timeoutMs?: number;
	mode?: FetchMode;
	timestamp?: string;
	frames?: number;
}

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

async function extractWithJinaReader(url: string, signal?: AbortSignal): Promise<ExtractedContent | null> {
	const jinaUrl = JINA_READER_BASE + url;

	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });

	try {
		const res = await fetch(jinaUrl, {
			headers: {
				Accept: "text/markdown",
				"X-No-Cache": "true",
			},
			signal: AbortSignal.any([AbortSignal.timeout(JINA_TIMEOUT_MS), ...(signal ? [signal] : [])]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const content = await res.text();
		activityMonitor.logComplete(activityId, res.status);

		const contentStart = content.indexOf("Markdown Content:");
		if (contentStart < 0) {
			return null;
		}

		const markdownPart = content.slice(contentStart + 17).trim(); // 17 = "Markdown Content:".length

		// Check for failed JS rendering or minimal content
		if (
			markdownPart.length < 100 ||
			markdownPart.startsWith("Loading...") ||
			markdownPart.startsWith("Please enable JavaScript")
		) {
			return null;
		}

		const title = extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdownPart, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

function parseTimestamp(ts: string): number | null {
	const num = Number(ts);
	if (!Number.isNaN(num) && num >= 0) return Math.floor(num);
	const parts = ts.split(":").map(Number);
	if (parts.some((p) => Number.isNaN(p) || p < 0)) return null;
	if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
	if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
	return null;
}

type TimestampSpec = { type: "single"; seconds: number } | { type: "range"; start: number; end: number };

function parseTimestampSpec(ts: string): TimestampSpec | null {
	const dashIdx = ts.indexOf("-", 1);
	if (dashIdx > 0) {
		const start = parseTimestamp(ts.slice(0, dashIdx));
		const end = parseTimestamp(ts.slice(dashIdx + 1));
		if (start !== null && end !== null && end > start) return { type: "range", start, end };
	}
	const seconds = parseTimestamp(ts);
	return seconds !== null ? { type: "single", seconds } : null;
}

const DEFAULT_RANGE_FRAMES = 6;
const MIN_FRAME_INTERVAL = 5;

function computeRangeTimestamps(start: number, end: number, maxFrames: number = DEFAULT_RANGE_FRAMES): number[] {
	if (maxFrames <= 1) return [start];
	const duration = end - start;
	const idealInterval = duration / (maxFrames - 1);
	if (idealInterval < MIN_FRAME_INTERVAL) {
		const timestamps: number[] = [];
		for (let t = start; t <= end && timestamps.length < maxFrames; t += MIN_FRAME_INTERVAL) {
			timestamps.push(t);
		}
		return timestamps;
	}
	return Array.from({ length: maxFrames }, (_, i) => Math.round(start + i * idealInterval));
}

function buildFrameResult(
	url: string,
	label: string,
	requestedCount: number,
	frames: VideoFrame[],
	error: string | null,
	duration?: number,
): ExtractedContent {
	if (frames.length === 0) {
		const msg = error ?? "Frame extraction failed";
		return { url, title: `Frames ${label} (0/${requestedCount})`, content: msg, error: msg };
	}
	return {
		url,
		title: `Frames ${label} (${frames.length}/${requestedCount})`,
		content: `${frames.length} frames extracted from ${label}`,
		error: null,
		frames,
		duration,
	};
}

async function extractLocalFrames(
	filePath: string,
	timestamps: number[],
): Promise<{ frames: VideoFrame[]; error: string | null }> {
	const results = await Promise.all(
		timestamps.map(async (t) => {
			const frame = await extractVideoFrame(filePath, t);
			if ("error" in frame) return { error: frame.error };
			return { ...frame, timestamp: formatSeconds(t) };
		}),
	);
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const firstError = results.find((f): f is { error: string } => "error" in f);
	return { frames, error: frames.length === 0 && firstError ? firstError.error : null };
}

function safeVideoInfo(url: string): { info: ReturnType<typeof isVideoFile>; error?: string } {
	try {
		return { info: isVideoFile(url) };
	} catch (err) {
		return { info: null, error: errorMessage(err) };
	}
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	if (options?.mode === "raw") {
		return extractRaw(url, signal, options);
	}

	if (options?.frames && !options.timestamp) {
		const frameCount = options.frames;
		const ytInfo = isYouTubeURL(url);
		if (ytInfo.isYouTube && ytInfo.videoId) {
			const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
			if ("error" in streamInfo) {
				return { url, title: "Frames", content: streamInfo.error, error: streamInfo.error };
			}
			if (streamInfo.duration === null) {
				const error = "Cannot determine video duration. Use a timestamp range instead.";
				return { url, title: "Frames", content: error, error };
			}
			const dur = Math.floor(streamInfo.duration);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, streamInfo.duration);
		}

		const localVideo = safeVideoInfo(url);
		if (localVideo.error) {
			return { url, title: "", content: "", error: localVideo.error };
		}
		if (localVideo.info) {
			const durationResult = await getLocalVideoDuration(localVideo.info.absolutePath);
			if (typeof durationResult !== "number") {
				return { url, title: "Frames", content: durationResult.error, error: durationResult.error };
			}
			const dur = Math.floor(durationResult);
			const timestamps = computeRangeTimestamps(0, dur, frameCount);
			const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
			const label = `${formatSeconds(0)}-${formatSeconds(dur)}`;
			return buildFrameResult(url, label, timestamps.length, result.frames, result.error, durationResult);
		}

		return { url, title: "", content: "", error: "Frame extraction only works with YouTube and local video files" };
	}

	if (options?.timestamp) {
		const spec = parseTimestampSpec(options.timestamp);
		if (!spec) {
			return {
				url,
				title: "",
				content: "",
				error: `Invalid timestamp format: "${options.timestamp}". Use "H:MM:SS", "MM:SS", "85", or "start-end".`,
			};
		}

		const frameCount = options.frames;
		const ytInfo = isYouTubeURL(url);
		if (ytInfo.isYouTube && ytInfo.videoId) {
			const streamInfo = await getYouTubeStreamInfo(ytInfo.videoId);
			if ("error" in streamInfo) {
				if (spec.type === "range") {
					const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
					return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
				}
				if (frameCount) {
					const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
					const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
					return { url, title: `Frames ${label}`, content: streamInfo.error, error: streamInfo.error };
				}
				return { url, title: `Frame at ${options.timestamp}`, content: streamInfo.error, error: streamInfo.error };
			}

			if (spec.type === "range") {
				const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
				if (streamInfo.duration !== null && spec.end > streamInfo.duration) {
					const error = `Timestamp ${formatSeconds(spec.end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
					return { url, title: `Frames ${label}`, content: error, error };
				}
				const timestamps = frameCount
					? computeRangeTimestamps(spec.start, spec.end, frameCount)
					: computeRangeTimestamps(spec.start, spec.end);
				const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
				return buildFrameResult(
					url,
					label,
					timestamps.length,
					result.frames,
					result.error,
					result.duration ?? undefined,
				);
			}

			if (frameCount) {
				const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
				const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
				if (streamInfo.duration !== null && end > streamInfo.duration) {
					const error = `Timestamp ${formatSeconds(end)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
					return { url, title: `Frames ${label}`, content: error, error };
				}
				const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
				const result = await extractYouTubeFrames(ytInfo.videoId, timestamps, streamInfo);
				return buildFrameResult(
					url,
					label,
					timestamps.length,
					result.frames,
					result.error,
					result.duration ?? undefined,
				);
			}

			if (streamInfo.duration !== null && spec.seconds > streamInfo.duration) {
				const error = `Timestamp ${formatSeconds(spec.seconds)} exceeds video duration (${formatSeconds(Math.floor(streamInfo.duration))})`;
				return { url, title: `Frame at ${options.timestamp}`, content: error, error };
			}
			const frame = await extractYouTubeFrame(ytInfo.videoId, spec.seconds, streamInfo);
			if ("error" in frame) {
				return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
			}
			return {
				url,
				title: `Frame at ${options.timestamp}`,
				content: `Video frame at ${options.timestamp}`,
				error: null,
				thumbnail: frame,
			};
		}

		const localVideo = safeVideoInfo(url);
		if (localVideo.error) {
			return { url, title: "", content: "", error: localVideo.error };
		}
		if (localVideo.info) {
			if (spec.type === "range") {
				const timestamps = frameCount
					? computeRangeTimestamps(spec.start, spec.end, frameCount)
					: computeRangeTimestamps(spec.start, spec.end);
				const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
				const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
			}

			if (frameCount) {
				const end = spec.seconds + (frameCount - 1) * MIN_FRAME_INTERVAL;
				const timestamps = computeRangeTimestamps(spec.seconds, end, frameCount);
				const result = await extractLocalFrames(localVideo.info.absolutePath, timestamps);
				const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
				return buildFrameResult(url, label, timestamps.length, result.frames, result.error);
			}

			const frame = await extractVideoFrame(localVideo.info.absolutePath, spec.seconds);
			if ("error" in frame) {
				return { url, title: `Frame at ${options.timestamp}`, content: frame.error, error: frame.error };
			}
			return {
				url,
				title: `Frame at ${options.timestamp}`,
				content: `Video frame at ${options.timestamp}`,
				error: null,
				thumbnail: frame,
			};
		}

		return { url, title: "", content: "", error: "Timestamp extraction only works with YouTube and local video files" };
	}

	const localVideo = safeVideoInfo(url);
	if (localVideo.error) {
		return { url, title: "", content: "", error: localVideo.error };
	}
	if (localVideo.info) {
		return {
			url,
			title: "",
			content: "",
			error: "Video content analysis is unavailable. Use timestamp or frames to extract images.",
		};
	}

	try {
		new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	try {
		const ghResult = await extractGitHub(url, signal);
		if (ghResult) return ghResult;
		if (signal?.aborted) return abortedResult(url);
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { url, title: "", content: "", error: message };
		}
	}

	if (isYouTubeURL(url).isYouTube) {
		return {
			url,
			title: "",
			content: "",
			error: "YouTube content analysis is unavailable. Use timestamp or frames to extract images.",
		};
	}

	if (signal?.aborted) return abortedResult(url);

	const httpResult = await extractViaHttp(url, signal, options);

	if (signal?.aborted) return abortedResult(url);
	if (!httpResult.error) return httpResult;
	if (NON_RECOVERABLE_ERRORS.some((prefix) => httpResult.error?.startsWith(prefix))) return httpResult;

	const jinaResult = await extractWithJinaReader(url, signal);
	if (jinaResult) return jinaResult;
	if (signal?.aborted) return abortedResult(url);

	if (signal?.aborted) return abortedResult(url);
	return httpResult;
}

function isLikelyJSRendered(html: string): boolean {
	// Extract body content
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const bodyHtml = bodyMatch[1];

	// Strip tags to get text content
	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// Count scripts
	const scriptCount = (html.match(/<script/gi) || []).length;

	// Heuristic: little text content but many scripts suggests JS rendering
	return textContent.length < 500 && scriptCount > 3;
}

// Servers that support markdown content negotiation (Cloudflare Markdown for
// Agents, Mintlify, Vercel) return markdown directly; others see the same
// HTML preference order a browser would send.
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const BROWSER_ACCEPT =
	"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
const MARKDOWN_FIRST_ACCEPT =
	"text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,application/xml;q=0.8,image/avif;q=0.9,image/webp;q=0.9,image/apng;q=0.9,*/*;q=0.7";

const RAW_MAX_BYTES = 5 * 1024 * 1024;

function isTextContentType(contentType: string): boolean {
	const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml" ||
		mimeType === "application/xhtml+xml" ||
		mimeType === "application/javascript" ||
		mimeType === "application/x-javascript" ||
		mimeType === "application/x-ndjson" ||
		mimeType === "application/yaml" ||
		mimeType.endsWith("+json") ||
		mimeType.endsWith("+xml")
	);
}

async function readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
	const tooLarge = () => new Error(`Response too large (${Math.round(maxBytes / 1024 / 1024)}MB)`);
	const reader = response.body?.getReader();
	let buffer: Uint8Array;
	if (!reader) {
		buffer = new Uint8Array(await response.arrayBuffer());
		if (buffer.byteLength > maxBytes) throw tooLarge();
	} else {
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				total += value.byteLength;
				if (total > maxBytes) {
					await reader.cancel();
					throw tooLarge();
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		buffer = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			buffer.set(chunk, offset);
			offset += chunk.byteLength;
		}
	}
	const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(buffer);
	} catch {
		return new TextDecoder("utf-8").decode(buffer);
	}
}

// mode: "raw" returns the server's own text body untouched. It asks for the
// normal browser representation (no markdown preference) and skips the
// GitHub/YouTube/video handlers, Readability, and the Jina fallback.
async function extractRaw(url: string, signal?: AbortSignal, options?: ExtractOptions): Promise<ExtractedContent> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { url, title: "", content: "", error: "Raw mode only supports http(s) URLs" };
	}

	const activityId = activityMonitor.logStart({ type: "fetch", url });
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": BROWSER_USER_AGENT,
				Accept: BROWSER_ACCEPT,
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
			},
		});

		const contentType = response.headers.get("content-type") || "";
		const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
		if (Number.isFinite(contentLength) && contentLength > RAW_MAX_BYTES) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
			};
		}
		if (!isTextContentType(contentType)) {
			activityMonitor.logComplete(activityId, response.status);
			await response.body?.cancel().catch(() => {});
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type in raw mode: ${mimeType || "missing"}. Raw mode only returns text responses.`,
			};
		}

		const text = await readTextWithLimit(response, RAW_MAX_BYTES);
		activityMonitor.logComplete(activityId, response.status);
		const title = extractTextTitle(text, url);
		if (!response.ok) {
			return { url, title, content: text, error: `HTTP ${response.status}: ${response.statusText}` };
		}
		return { url, title, content: text, error: null };
	} catch (err) {
		const message = errorMessage(err);
		if (isAbortError(err)) {
			activityMonitor.logComplete(activityId, 0);
			if (signal?.aborted) return abortedResult(url);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function extractViaHttp(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
	preferMarkdown = true,
): Promise<ExtractedContent> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": BROWSER_USER_AGENT,
				Accept: preferMarkdown ? MARKDOWN_FIRST_ACCEPT : BROWSER_ACCEPT,
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		});

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const contentLengthHeader = response.headers.get("content-length");
		const contentType = response.headers.get("content-type") || "";
		const isPDFContent = isPDF(url, contentType);
		const maxResponseSize = isPDFContent ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxResponseSize) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: "",
					content: "",
					error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		if (isPDFContent) {
			try {
				const buffer = await response.arrayBuffer();
				const result = await extractPDFToMarkdown(buffer, url);
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title,
					content: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`,
					error: null,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}` };
			}
		}

		if (
			contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")
		) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const text = await response.text();
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			const title = extractTextTitle(text, url);
			const mimeType = contentType.split(";")[0].trim().toLowerCase();
			const isMarkdown = mimeType === "text/markdown" || mimeType === "text/x-markdown";
			if (!isMarkdown || !preferMarkdown || text.trim().length >= MIN_USEFUL_CONTENT) {
				return { url, title, content: text, error: null };
			}
			// Very short negotiated markdown is often a stub. Ask again the way a
			// browser would; the markdown only fills in when that attempt has nothing.
			const normal = await extractViaHttp(url, signal, options, false);
			if (signal?.aborted || normal.content.trim()) return normal;
			return { url, title, content: text, error: "Extracted content appears incomplete" };
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			const rscResult = extractRSCContent(text);
			if (rscResult) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: rscResult.title, content: rscResult.content, error: null };
			}

			activityMonitor.logComplete(activityId, response.status);

			// Provide more specific error message
			const jsRendered = isLikelyJSRendered(text);
			const errorMsg = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";

			return {
				url,
				title: "",
				content: "",
				error: errorMsg,
			};
		}

		const markdown = turndown.turndown(article.content ?? "");
		activityMonitor.logComplete(activityId, response.status);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			return {
				url,
				title: article.title || "",
				content: markdown,
				error: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
			};
		}

		return { url, title: article.title || "", content: markdown, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent[]> {
	const results = await Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, options))));
	// Raw mode promises the exact body, so it is the one path left untouched.
	if (options?.mode === "raw") return results;
	return sanitizeExtractedContents(results);
}
