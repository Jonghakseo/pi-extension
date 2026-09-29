import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractContent } from "./extract.js";

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
