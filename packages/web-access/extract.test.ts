import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setConfigPathForTests } from "./config.js";
import { extractContent, fetchAllContent } from "./extract.js";

// The SSRF guard blocks loopback, so the local test servers need an explicit exemption.
let configDir: string;
beforeAll(() => {
	configDir = mkdtempSync(join(tmpdir(), "web-access-extract-config-"));
	const configPath = join(configDir, "web-search.json");
	writeFileSync(configPath, JSON.stringify({ ssrf: { allowRanges: ["127.0.0.0/8"] } }));
	setConfigPathForTests(configPath);
});
afterAll(() => {
	setConfigPathForTests(null);
	rmSync(configDir, { recursive: true, force: true });
});

describe("web content without Gemini", () => {
	it("extracts a readable page from a local HTTP server", async () => {
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "text/html");
			response.end(
				`<html><body><article><h1>Local article</h1>${"<p>Readable page content for extraction.</p>".repeat(35)}</article></body></html>`,
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP address");
			const result = await extractContent(`http://127.0.0.1:${address.port}/article`);
			expect(result.error).toBeNull();
			expect(result.content).toContain("Readable page content for extraction.");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});

describe("markdown-first content negotiation", () => {
	async function withServer(
		handler: Parameters<typeof createServer>[1],
		run: (url: string) => Promise<void>,
	): Promise<void> {
		const server = createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP address");
			await run(`http://127.0.0.1:${address.port}/doc`);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	}

	it("asks for text/markdown first and returns a markdown body untouched", async () => {
		const markdown = `# Negotiated title\n\n${"- keeps *markdown* syntax as is\n".repeat(30)}`;
		let accept = "";
		await withServer(
			(request, response) => {
				accept = String(request.headers.accept);
				response.setHeader("content-type", "text/markdown; charset=utf-8");
				response.end(markdown);
			},
			async (url) => {
				const result = await extractContent(url);
				expect(accept.startsWith("text/markdown")).toBe(true);
				expect(result.error).toBeNull();
				expect(result.title).toBe("Negotiated title");
				expect(result.content).toBe(markdown);
			},
		);
	});

	it("still reads HTML from servers that ignore the markdown preference", async () => {
		await withServer(
			(_request, response) => {
				response.setHeader("content-type", "text/html");
				response.end(
					`<html><body><article><h1>HTML only</h1>${"<p>Plain HTML paragraph for extraction.</p>".repeat(35)}</article></body></html>`,
				);
			},
			async (url) => {
				const result = await extractContent(url);
				expect(result.error).toBeNull();
				expect(result.content).toContain("Plain HTML paragraph for extraction.");
			},
		);
	});

	it("retries with a browser Accept header when negotiated markdown is a short stub", async () => {
		const accepts: string[] = [];
		await withServer(
			(request, response) => {
				const accept = String(request.headers.accept);
				accepts.push(accept);
				if (accept.startsWith("text/markdown")) {
					response.setHeader("content-type", "text/markdown");
					response.end("# Stub");
					return;
				}
				response.setHeader("content-type", "text/html");
				response.end(
					`<html><body><article><h1>Full page</h1>${"<p>Full HTML body after retry.</p>".repeat(35)}</article></body></html>`,
				);
			},
			async (url) => {
				const result = await extractContent(url);
				expect(accepts).toHaveLength(2);
				expect(accepts[1].startsWith("text/html")).toBe(true);
				expect(result.error).toBeNull();
				expect(result.content).toContain("Full HTML body after retry.");
			},
		);
	});
});

describe("fetch mode raw", () => {
	async function withServer(
		handler: Parameters<typeof createServer>[1],
		run: (url: string) => Promise<void>,
	): Promise<void> {
		const server = createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP address");
			await run(`http://127.0.0.1:${address.port}/data`);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	}

	it("returns a JSON body untouched without asking for markdown", async () => {
		const body = `{\n  "name": "raw",\n  "items": [1, 2, 3]\n}`;
		let accept = "";
		await withServer(
			(request, response) => {
				accept = String(request.headers.accept);
				response.setHeader("content-type", "application/json");
				response.end(body);
			},
			async (url) => {
				const result = await extractContent(url, undefined, { mode: "raw" });
				expect(result.error).toBeNull();
				expect(result.content).toBe(body);
				expect(accept.startsWith("text/html")).toBe(true);
			},
		);
	});

	it("does not run Readability on an HTML response", async () => {
		const html = `<html><body><nav>menu</nav><article><p>short</p></article></body></html>`;
		await withServer(
			(_request, response) => {
				response.setHeader("content-type", "text/html; charset=utf-8");
				response.end(html);
			},
			async (url) => {
				const result = await extractContent(url, undefined, { mode: "raw" });
				expect(result.error).toBeNull();
				expect(result.content).toBe(html);
			},
		);
	});

	it("rejects binary content types with a clear error", async () => {
		await withServer(
			(_request, response) => {
				response.setHeader("content-type", "application/pdf");
				response.end("%PDF-1.4");
			},
			async (url) => {
				const result = await extractContent(url, undefined, { mode: "raw" });
				expect(result.error).toContain("Unsupported content type in raw mode: application/pdf");
				expect(result.content).toBe("");
			},
		);
	});

	it("rejects bodies over 5MB even without a content-length header", async () => {
		await withServer(
			(_request, response) => {
				response.setHeader("content-type", "text/plain");
				response.write(Buffer.alloc(3 * 1024 * 1024, "a"));
				response.end(Buffer.alloc(3 * 1024 * 1024, "a"));
			},
			async (url) => {
				const result = await extractContent(url, undefined, { mode: "raw" });
				expect(result.error).toContain("Response too large");
				expect(result.content).toBe("");
			},
		);
	});

	it("refuses non-http URLs instead of reading local files", async () => {
		const result = await extractContent("file:///etc/hosts", undefined, { mode: "raw" });
		expect(result.error).toContain("http(s)");
	});

	it("keeps an HTTP error status as an error while returning the body", async () => {
		await withServer(
			(_request, response) => {
				response.statusCode = 404;
				response.setHeader("content-type", "application/json");
				response.end('{"error":"missing"}');
			},
			async (url) => {
				const result = await extractContent(url, undefined, { mode: "raw" });
				expect(result.error).toContain("HTTP 404");
				expect(result.content).toBe('{"error":"missing"}');
			},
		);
	});
});

describe("inline data URI removal", () => {
	const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
	const markdown = `# Page with image\n\n${"Some readable text. ".repeat(40)}\n\n![pixel](data:image/png;base64,${payload})\n`;

	async function withMarkdownServer(run: (url: string) => Promise<void>): Promise<void> {
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "text/markdown");
			response.end(markdown);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP address");
			await run(`http://127.0.0.1:${address.port}/page`);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	}

	it("replaces data URIs in fetched content with an omission marker", async () => {
		await withMarkdownServer(async (url) => {
			const [result] = await fetchAllContent([url]);
			expect(result.error).toBeNull();
			expect(result.content).toContain("![pixel](");
			expect(result.content).toContain("inline data URI omitted");
			expect(result.content).not.toContain(payload);
			expect(result.content).not.toMatch(/data:image/i);
		});
	});

	it("leaves raw mode bodies exactly as served", async () => {
		await withMarkdownServer(async (url) => {
			const [result] = await fetchAllContent([url], undefined, { mode: "raw" });
			expect(result.content).toBe(markdown);
		});
	});
});

describe("video content without Gemini", () => {
	it("explains how to extract images from a YouTube URL", async () => {
		const result = await extractContent("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		expect(result.error).toContain("Use timestamp or frames");
	});

	it("explains how to extract images from a local video", async () => {
		const dir = mkdtempSync(join(tmpdir(), "web-access-video-"));
		try {
			const file = join(dir, "clip.mp4");
			writeFileSync(file, "placeholder");
			const result = await extractContent(file);
			expect(result.error).toContain("Use timestamp or frames");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(Boolean(spawnSync("ffmpeg", ["-version"]).error || spawnSync("ffprobe", ["-version"]).error))(
		"extracts a real JPEG frame from a local video without an API key",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "web-access-frames-"));
			try {
				const file = join(dir, "clip.mp4");
				execFileSync("ffmpeg", [
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					"color=c=black:s=16x16:d=1",
					"-c:v",
					"mpeg4",
					"-y",
					file,
				]);
				const result = await extractContent(file, undefined, { frames: 1 });
				expect(result.error).toBeNull();
				expect(result.frames?.[0]?.mimeType).toBe("image/jpeg");
				expect(result.frames?.[0]?.data).toMatch(/^\/9j\//);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
