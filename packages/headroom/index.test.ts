import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { loadHeadroomConfig } from "./config.ts";
import { __test__ } from "./index.ts";
import type { HeadroomStats } from "./types.ts";

function createContext(theme: unknown): ExtensionContext {
	return {
		hasUI: true,
		ui: { theme },
	} as ExtensionContext;
}

function createStats(): HeadroomStats {
	return { attempts: 0, applied: 0, guardSkips: 0, tokensSaved: 0 };
}

describe("headroom error classification", () => {
	it("treats timeout and abort errors as transient compression skips", () => {
		expect(
			__test__.isAbortOrTimeoutError(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
		).toBe(true);
		expect(__test__.isAbortOrTimeoutError(new DOMException("The operation was aborted", "AbortError"))).toBe(true);
		expect(__test__.isAbortOrTimeoutError(new Error("The operation was aborted due to timeout"))).toBe(true);
	});

	it("does not treat regular Headroom failures as transient aborts", () => {
		expect(__test__.isAbortOrTimeoutError(new Error("Headroom /v1/compress failed with HTTP 500"))).toBe(false);
	});
});

describe("headroom status rendering", () => {
	it("falls back to plain text when the UI theme cannot color text", () => {
		const config = loadHeadroomConfig({});
		const ctx = createContext({});

		const status = __test__.renderFooterStatus(ctx, config, {
			enabled: true,
			proxyOnline: true,
			proxyStarting: false,
			proxyStartAttempted: false,
			remoteWarningShown: false,
			offlineWarningShown: false,
			stats: createStats(),
		});

		expect(status).toBe("✓ Headroom");
	});

	it("uses theme colors when the UI theme exposes fg", () => {
		const config = loadHeadroomConfig({});
		const ctx = createContext({
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		});

		const status = __test__.renderFooterStatus(ctx, config, {
			enabled: true,
			proxyOnline: true,
			proxyStarting: false,
			proxyStartAttempted: false,
			remoteWarningShown: false,
			offlineWarningShown: false,
			stats: createStats(),
		});

		expect(status).toBe("<success>✓</success><dim> Headroom</dim>");
	});
});
