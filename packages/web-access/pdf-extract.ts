/**
 * PDF Content Extractor
 *
 * Extracts text from PDF files and saves to markdown.
 * Uses unpdf (pdfjs-dist wrapper) for text extraction.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getDocumentProxy } from "unpdf";

export interface PDFExtractResult {
	title: string;
	pages: number;
	chars: number;
	outputPath: string;
}

export interface PDFExtractOptions {
	maxPages?: number;
	outputDir?: string;
	filename?: string;
}

const DEFAULT_MAX_PAGES = 100;
const DEFAULT_OUTPUT_DIR = join(homedir(), "Downloads");
const MAX_FILENAME_CODEPOINTS = 80;

type PDFProxy = Awaited<ReturnType<typeof getDocumentProxy>>;
type PDFPage = Awaited<ReturnType<PDFProxy["getPage"]>>;

interface PageText {
	pageNum: number;
	text: string;
}

interface PageExtractionResult {
	pages: PageText[];
	failures: number[];
}

interface PDFMeta {
	title?: string;
	author?: string;
}

/**
 * Extract text from a PDF buffer and save to markdown file
 */
export async function extractPDFToMarkdown(
	buffer: ArrayBuffer,
	url: string,
	options: PDFExtractOptions = {},
): Promise<PDFExtractResult> {
	const { maxPages = DEFAULT_MAX_PAGES, outputDir = DEFAULT_OUTPUT_DIR, filename } = options;

	const safeMaxPages = clampPageLimit(maxPages);
	const pdf = await getDocumentProxy(new Uint8Array(buffer));
	const meta = await readMeta(pdf);

	const title = meta.title || extractTitleFromURL(url);
	const pagesToExtract = Math.min(pdf.numPages, safeMaxPages);
	const truncated = pdf.numPages > safeMaxPages;

	const { pages, failures } = await extractAllPages(pdf, pagesToExtract);

	const content = buildMarkdown({
		title,
		url,
		author: meta.author,
		totalPages: pdf.numPages,
		pagesExtracted: pagesToExtract,
		truncated,
		failedPages: failures,
		pages,
	});

	await mkdir(outputDir, { recursive: true });
	const outputPath = await resolveOutputPath(outputDir, filename ?? `${sanitizeFilename(title)}.md`);
	await writeFile(outputPath, content, "utf-8");

	return {
		title,
		pages: pdf.numPages,
		chars: content.length,
		outputPath,
	};
}

function clampPageLimit(value: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : DEFAULT_MAX_PAGES;
}

async function readMeta(pdf: PDFProxy): Promise<PDFMeta> {
	try {
		const metadata = await pdf.getMetadata();
		const info = metadata.info && typeof metadata.info === "object" ? (metadata.info as Record<string, unknown>) : null;
		const title = typeof info?.Title === "string" ? info.Title.trim() : "";
		const author = typeof info?.Author === "string" ? info.Author.trim() : "";
		return {
			title: title || undefined,
			author: author || undefined,
		};
	} catch {
		return {};
	}
}

async function extractAllPages(pdf: PDFProxy, count: number): Promise<PageExtractionResult> {
	const pages: PageText[] = [];
	const failures: number[] = [];

	for (let i = 1; i <= count; i++) {
		try {
			const page = await pdf.getPage(i);
			const text = await extractPageText(page);
			if (text) {
				pages.push({ pageNum: i, text });
			}
		} catch {
			failures.push(i);
		}
	}

	return { pages, failures };
}

async function extractPageText(page: PDFPage): Promise<string> {
	const { items } = await page.getTextContent();
	const parts: string[] = [];

	for (const raw of items) {
		const item = raw as { str?: string; hasEOL?: boolean };
		const str = item.str ?? "";
		if (str) {
			parts.push(str);
		}
		if (item.hasEOL) {
			parts.push("\n");
		} else if (str) {
			parts.push(" ");
		}
	}

	return parts
		.join("")
		.replace(/[ \t]+/g, " ")
		.replace(/[ \t]*\n[ \t]*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

interface MarkdownArgs {
	title: string;
	url: string;
	author?: string;
	totalPages: number;
	pagesExtracted: number;
	truncated: boolean;
	failedPages: number[];
	pages: PageText[];
}

function buildMarkdown(args: MarkdownArgs): string {
	const { title, url, author, totalPages, pagesExtracted, truncated, failedPages, pages } = args;
	const lines: string[] = [];

	lines.push(`# ${title}`);
	lines.push("");
	lines.push(`> Source: ${url}`);
	lines.push(`> Pages: ${totalPages}${truncated ? ` (extracted first ${pagesExtracted})` : ""}`);
	if (author) {
		lines.push(`> Author: ${author}`);
	}
	if (failedPages.length > 0) {
		lines.push(`> Failed pages: ${failedPages.join(", ")}`);
	}
	lines.push("");
	lines.push("---");
	lines.push("");

	for (let i = 0; i < pages.length; i++) {
		if (i > 0) {
			lines.push("");
			lines.push(`<!-- Page ${pages[i].pageNum} -->`);
			lines.push("");
		}
		lines.push(pages[i].text);
	}

	if (truncated) {
		lines.push("");
		lines.push("---");
		lines.push("");
		lines.push(`*[Truncated: Only first ${pagesExtracted} of ${totalPages} pages extracted]*`);
	}

	return lines.join("\n");
}

/**
 * Extract a reasonable title from URL.
 * Recognises both modern (1706.03762) and legacy (cs/0701001) arXiv IDs.
 */
function extractTitleFromURL(url: string): string {
	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname;

		if (urlObj.hostname.includes("arxiv.org")) {
			const match = pathname.match(/\/(?:pdf|abs)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/)?\d+(?:\.\d+)?)/);
			if (match) {
				return `arxiv-${match[1].replace("/", "-")}`;
			}
		}

		const filename = basename(pathname, ".pdf").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
		return filename || "document";
	} catch {
		return "document";
	}
}

/**
 * Build a filesystem-safe filename. Keeps Unicode letters/numbers so
 * non-ASCII titles (Korean, Japanese, etc.) don't collapse to "document".
 */
function sanitizeFilename(name: string): string {
	const cleaned = name
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	if (!cleaned) {
		return "document";
	}

	const codepoints = [...cleaned];
	const truncated =
		codepoints.length > MAX_FILENAME_CODEPOINTS ? codepoints.slice(0, MAX_FILENAME_CODEPOINTS).join("") : cleaned;

	return truncated.replace(/-+$/g, "") || "document";
}

/**
 * Append `-2`, `-3`, ... until the path doesn't exist.
 */
async function resolveOutputPath(dir: string, filename: string): Promise<string> {
	const hasExt = /\.md$/i.test(filename);
	const base = hasExt ? filename.replace(/\.md$/i, "") : filename;

	let candidate = `${base}.md`;
	let i = 1;
	while (await pathExists(join(dir, candidate))) {
		i += 1;
		candidate = `${base}-${i}.md`;
	}
	return join(dir, candidate);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if URL or content-type indicates a PDF
 */
export function isPDF(url: string, contentType?: string): boolean {
	if (contentType?.includes("application/pdf")) {
		return true;
	}
	try {
		const urlObj = new URL(url);
		return urlObj.pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}
