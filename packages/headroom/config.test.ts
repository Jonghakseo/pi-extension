import { describe, expect, it } from "vitest";
import { isRemoteBlocked, loadHeadroomConfig } from "./config.ts";

describe("headroom config", () => {
	it("defaults to local compression-only proxy with conservative thresholds", () => {
		const config = loadHeadroomConfig({});

		expect(config.enabled).toBe(true);
		expect(config.baseUrl).toBe("http://127.0.0.1:8788");
		expect(config.allowRemote).toBe(false);
		expect(config.autoStart).toBe(true);
		expect(config.command).toBe("headroom");
		expect(config.minContextTokens).toBe(20_000);
		expect(config.minMessageChars).toBe(2_000);
	});

	it("blocks remote proxy URLs unless explicitly allowed", () => {
		const blocked = loadHeadroomConfig({ PI_HEADROOM_URL: "https://headroom.example.com/" });
		const allowed = loadHeadroomConfig({
			PI_HEADROOM_URL: "https://headroom.example.com/",
			PI_HEADROOM_ALLOW_REMOTE: "1",
		});

		expect(blocked.baseUrl).toBe("https://headroom.example.com");
		expect(isRemoteBlocked(blocked)).toBe(true);
		expect(isRemoteBlocked(allowed)).toBe(false);
	});

	it("parses boolean and integer overrides", () => {
		const config = loadHeadroomConfig({
			PI_HEADROOM_ENABLED: "off",
			PI_HEADROOM_MIN_CONTEXT_TOKENS: "1000",
			PI_HEADROOM_MIN_MESSAGE_CHARS: "500",
			PI_HEADROOM_TIMEOUT_MS: "3000",
			PI_HEADROOM_AUTO_START: "false",
			PI_HEADROOM_COMMAND: "custom-headroom",
		});

		expect(config.enabled).toBe(false);
		expect(config.autoStart).toBe(false);
		expect(config.command).toBe("custom-headroom");
		expect(config.minContextTokens).toBe(1000);
		expect(config.minMessageChars).toBe(500);
		expect(config.timeoutMs).toBe(3000);
	});
});
