import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sanitizeExtractedContents, sanitizeInlineDataUris } from "./data-uri-sanitize.js";

const MARKER = "[pi-web-access inline data URI omitted;";

describe("sanitizeInlineDataUris", () => {
	it("replaces a large base64 image with a short marker and keeps surrounding markdown", () => {
		const encoded = Buffer.alloc(240 * 1024, 0xa5).toString("base64");
		const input = `Before ![diagram](data:image/png;base64,${encoded}) after.`;
		const { text, omissions } = sanitizeInlineDataUris(input, "urls[0].content");
		expect(text.startsWith("Before ![diagram](")).toBe(true);
		expect(text.endsWith(") after.")).toBe(true);
		expect(text).not.toMatch(/data:/i);
		expect(text).not.toContain(encoded.slice(0, 64));
		expect(text.length).toBeLessThan(500);
		expect(omissions).toHaveLength(1);
		expect(omissions[0]).toMatchObject({
			mimeType: "image/png",
			encoding: "base64",
			encodedBytes: encoded.length,
			decodedBytes: 240 * 1024,
		});
		expect(text).toContain(`decodedBytes=${240 * 1024}`);
		expect(text).toContain("retrieval=not-retained]");
	});

	it("digests the decoded bytes of a percent-encoded SVG", () => {
		const decoded = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
		const { text, omissions } = sanitizeInlineDataUris(
			`![v](data:image/svg+xml;charset=utf-8,${encodeURIComponent(decoded)})`,
			"urls[0].content",
		);
		expect(omissions[0].encoding).toBe("percent-encoded");
		expect(omissions[0].decodedBytes).toBe(Buffer.byteLength(decoded));
		expect(omissions[0].sha256).toBe(createHash("sha256").update(decoded).digest("hex"));
		expect(text).not.toContain("svg+xml;charset");
	});

	it("removes malformed URIs without leaking the payload and numbers markers in order", () => {
		const { text, omissions } = sanitizeInlineDataUris(
			'<img src="data:image/png;base64,QUFB QkJC"> and ![x](data:text/plain,abc(def)ghi)',
			"urls[0].content",
		);
		expect(omissions.map((o) => o.ordinal)).toEqual([1, 2]);
		expect(omissions[0].decodeError).toBe("invalid-base64-character");
		expect(text.split(MARKER)).toHaveLength(3);
		for (const leaked of ["QUFB", "QkJC", "abc(def)ghi", "ghi)"]) expect(text).not.toContain(leaked);
	});

	it("leaves ordinary prose such as 'data: value' alone", () => {
		const input = "The data: value is shown here, see metadata:foo too.";
		const result = sanitizeInlineDataUris(input, "urls[0].content");
		expect(result.text).toBe(input);
		expect(result.omissions).toHaveLength(0);
	});

	it("stays fast on thousands of malformed comma-less candidates", () => {
		const input = Array.from({ length: 4000 }, () => "data:x;").join(" ");
		const started = performance.now();
		const { omissions } = sanitizeInlineDataUris(input, "urls[0].content");
		expect(omissions).toHaveLength(4000);
		expect(performance.now() - started).toBeLessThan(10_000);
	});
});

describe("sanitizeExtractedContents", () => {
	it("sanitizes only results that contain data URIs and indexes the source by position", () => {
		const clean = { url: "https://a.test", content: "plain text" };
		const dirty = { url: "https://b.test", content: "![i](data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==)" };
		const [first, second] = sanitizeExtractedContents([clean, dirty]);
		expect(first).toBe(clean);
		expect(second.url).toBe("https://b.test");
		expect(second.content).toContain("source=urls[1].content;");
		expect(second.content).not.toMatch(/data:/i);
		expect(dirty.content).toContain("data:image/gif");
	});
});
