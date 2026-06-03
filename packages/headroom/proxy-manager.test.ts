import { describe, expect, it } from "vitest";
import { buildProxyArgs, parseLocalEndpoint } from "./proxy-manager.ts";

describe("headroom proxy manager", () => {
	it("parses supported local endpoints", () => {
		expect(parseLocalEndpoint("http://127.0.0.1:8787")).toEqual({ host: "127.0.0.1", port: "8787" });
		expect(parseLocalEndpoint("http://localhost:9999")).toEqual({ host: "127.0.0.1", port: "9999" });
		expect(parseLocalEndpoint("http://[::1]:8788")).toEqual({ host: "::1", port: "8788" });
	});

	it("rejects remote and invalid endpoints", () => {
		expect(parseLocalEndpoint("https://headroom.example.com")).toBeUndefined();
		expect(parseLocalEndpoint("ftp://127.0.0.1:8787")).toBeUndefined();
		expect(parseLocalEndpoint("not a url")).toBeUndefined();
	});

	it("builds token-only persistent proxy args", () => {
		expect(buildProxyArgs({ host: "127.0.0.1", port: "8787" })).toEqual([
			"proxy",
			"--host",
			"127.0.0.1",
			"--port",
			"8787",
			"--mode",
			"token",
			"--no-cache",
		]);
	});
});
