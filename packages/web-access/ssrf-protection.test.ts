import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setConfigPathForTests } from "./config.js";
import { extractContent } from "./extract.js";
import { fetchRemoteUrl, loadDomainPolicy, validateRemoteUrl } from "./ssrf-protection.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const NO_POLICY = { allow: [], deny: [] };

function stubFetch(handler: (url: string) => Response) {
	return vi.fn(async (input: string | URL | Request) => handler(String(input))) as unknown as typeof fetch;
}

describe("validateRemoteUrl", () => {
	const blocked = [
		"http://127.0.0.1/",
		"http://localhost/",
		"http://app.localhost/",
		"http://10.0.0.5/",
		"http://192.168.1.1/",
		"http://172.16.0.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://2130706433/",
		"http://[::1]/",
		"http://[fd00:ec2::254]/",
		"http://[fe80::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:a00:1]/",
	];
	for (const url of blocked) {
		it(`blocks ${url}`, async () => {
			await expect(validateRemoteUrl(url, { domainPolicy: NO_POLICY, allowRanges: [] })).rejects.toThrow(
				/^Blocked internal/,
			);
		});
	}

	it("blocks a hostname that resolves to a private address", async () => {
		const lookup = async () => [
			{ address: "93.184.216.34", family: 4 },
			{ address: "10.1.2.3", family: 4 },
		];
		await expect(
			validateRemoteUrl("https://rebind.example/", { lookup, domainPolicy: NO_POLICY, allowRanges: [] }),
		).rejects.toThrow("Blocked internal address for rebind.example: 10.1.2.3");
	});

	it("allows public addresses and rejects non-http schemes", async () => {
		await expect(
			validateRemoteUrl("https://example.com/a", { lookup: publicLookup, domainPolicy: NO_POLICY, allowRanges: [] }),
		).resolves.toBeInstanceOf(URL);
		await expect(validateRemoteUrl("file:///etc/passwd", { domainPolicy: NO_POLICY })).rejects.toThrow(
			"Only HTTP and HTTPS",
		);
	});

	it("lets allowRanges exempt a synthetic range", async () => {
		const lookup = async () => [{ address: "198.18.0.7", family: 4 }];
		await expect(
			validateRemoteUrl("https://fake-ip.example/", { lookup, domainPolicy: NO_POLICY, allowRanges: [] }),
		).rejects.toThrow("198.18.0.0/15");
		await expect(
			validateRemoteUrl("https://fake-ip.example/", {
				lookup,
				domainPolicy: NO_POLICY,
				allowRanges: ["198.18.0.0/15"],
			}),
		).resolves.toBeInstanceOf(URL);
	});

	it("opens localhost only when allowRanges covers loopback, and says how", async () => {
		const base = { domainPolicy: NO_POLICY };
		for (const url of ["http://localhost:3000/", "http://app.localhost/"]) {
			await expect(validateRemoteUrl(url, { ...base, allowRanges: [] })).rejects.toThrow("ssrf.allowRanges");
			await expect(validateRemoteUrl(url, { ...base, allowRanges: ["10.0.0.0/8"] })).rejects.toThrow("Blocked");
			await expect(validateRemoteUrl(url, { ...base, allowRanges: ["127.0.0.0/8"] })).resolves.toBeInstanceOf(URL);
			await expect(validateRemoteUrl(url, { ...base, allowRanges: ["::1/128"] })).resolves.toBeInstanceOf(URL);
		}
	});

	it("explains ssrf.allowRanges when a private address is blocked", async () => {
		await expect(validateRemoteUrl("http://10.0.0.5/", { domainPolicy: NO_POLICY, allowRanges: [] })).rejects.toThrow(
			"ssrf.allowRanges",
		);
	});

	it("matches domain policy hosts and subdomains, deny first, allow as a whitelist", async () => {
		const options = {
			lookup: publicLookup,
			allowRanges: [],
			domainPolicy: { allow: ["example.com"], deny: ["bad.example.com"] },
		};
		await expect(validateRemoteUrl("https://example.com/", options)).resolves.toBeInstanceOf(URL);
		await expect(validateRemoteUrl("https://docs.example.com/", options)).resolves.toBeInstanceOf(URL);
		await expect(validateRemoteUrl("https://x.bad.example.com/", options)).rejects.toThrow("Blocked hostname");
		await expect(validateRemoteUrl("https://notexample.com/", options)).rejects.toThrow("Hostname not allowed");
	});
});

describe("fetchRemoteUrl", () => {
	it("checks every redirect hop and never requests the blocked target", async () => {
		const fetchImpl = stubFetch((url) =>
			url.startsWith("https://public.example")
				? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
				: new Response("secret"),
		);
		await expect(
			fetchRemoteUrl(
				"https://public.example/start",
				{},
				{
					fetch: fetchImpl,
					lookup: publicLookup,
					domainPolicy: NO_POLICY,
					allowRanges: [],
				},
			),
		).rejects.toThrow("Blocked internal address");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("follows redirects between public hosts and stops after too many", async () => {
		const ok = stubFetch((url) =>
			url.endsWith("/start")
				? new Response(null, { status: 301, headers: { location: "/end" } })
				: new Response("done"),
		);
		const base = { lookup: publicLookup, domainPolicy: NO_POLICY, allowRanges: [] };
		const response = await fetchRemoteUrl("https://public.example/start", {}, { ...base, fetch: ok });
		expect(await response.text()).toBe("done");

		const loop = stubFetch(() => new Response(null, { status: 302, headers: { location: "/again" } }));
		await expect(
			fetchRemoteUrl("https://public.example/", {}, { ...base, fetch: loop, maxRedirects: 2 }),
		).rejects.toThrow("Too many redirects");
	});

	it("applies the domain policy to redirect targets", async () => {
		const fetchImpl = stubFetch(
			() => new Response(null, { status: 302, headers: { location: "https://denied.example/x" } }),
		);
		await expect(
			fetchRemoteUrl(
				"https://public.example/",
				{},
				{
					fetch: fetchImpl,
					lookup: publicLookup,
					allowRanges: [],
					domainPolicy: { allow: [], deny: ["denied.example"] },
				},
			),
		).rejects.toThrow("Blocked hostname by fetch_content domain policy: denied.example");
	});
});

describe("config-driven behavior through extractContent", () => {
	let dir: string | null = null;
	afterEach(() => {
		setConfigPathForTests(null);
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	function useConfig(config: unknown): void {
		dir = mkdtempSync(join(tmpdir(), "web-access-ssrf-config-"));
		const path = join(dir, "web-search.json");
		writeFileSync(path, JSON.stringify(config));
		setConfigPathForTests(path);
	}

	it("applies the domain policy to YouTube frame requests before any video lookup", async () => {
		useConfig({ fetchContent: { domainPolicy: { deny: ["youtube.com"] } } });
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			const result = await extractContent("https://www.youtube.com/watch?v=dQw4w9WgXcQ", undefined, { frames: 2 });
			expect(result.error).toContain("Blocked hostname by fetch_content domain policy");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("does not send an allowRanges-exempted internal URL to the Jina fallback", async () => {
		useConfig({ ssrf: { allowRanges: ["127.0.0.0/8"] } });
		const server = createServer((_request, response) => {
			response.statusCode = 500;
			response.end("boom");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const realFetch = globalThis.fetch;
		const jinaCalls: string[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const target = String(input);
			if (target.includes("r.jina.ai")) {
				jinaCalls.push(target);
				return new Response("", { status: 404 });
			}
			return realFetch(input, init);
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP address");
			const result = await extractContent(`http://127.0.0.1:${address.port}/page`);
			expect(result.error).toContain("HTTP 500");
			expect(jinaCalls).toEqual([]);
		} finally {
			fetchSpy.mockRestore();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("refuses loopback targets by default in readable and raw mode without any request", async () => {
		useConfig({});
		let hits = 0;
		const server = createServer((_request, response) => {
			hits++;
			response.end("hello");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP address");
			const url = `http://127.0.0.1:${address.port}/`;
			const readable = await extractContent(url);
			const raw = await extractContent(url, undefined, { mode: "raw" });
			expect(readable.error).toContain("Blocked internal address");
			expect(raw.error).toContain("Blocked internal address");
			expect(hits).toBe(0);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("applies fetchContent.domainPolicy to all HTTP(S) sources, including GitHub", async () => {
		useConfig({ fetchContent: { domainPolicy: { deny: ["github.com", "blocked.example"] } } });
		expect(loadDomainPolicy().deny).toEqual(["github.com", "blocked.example"]);
		const github = await extractContent("https://github.com/owner/repo");
		const page = await extractContent("https://www.blocked.example/page");
		expect(github.error).toBe("Blocked hostname by fetch_content domain policy: github.com");
		expect(page.error).toBe("Blocked hostname by fetch_content domain policy: www.blocked.example");
	});

	it("rejects a malformed domainPolicy instead of silently turning it off", async () => {
		useConfig({ fetchContent: { domainPolicy: { deny: "example.com" } } });
		const result = await extractContent("https://example.com/", undefined, { mode: "raw" });
		expect(result.error).toContain("fetchContent.domainPolicy.deny must be an array");
	});
});
