import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import idleScreensaver from "./index.ts";

describe("idle-screensaver extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("opens the overlay after the idle timeout", async () => {
		const apiMock = createExtensionApiMock("Release dashboard");
		idleScreensaver(apiMock.api);
		const sessionStartHandler = apiMock.getHandlers("session_start")[0];
		if (!sessionStartHandler) throw new Error("session_start handler missing");

		const custom = vi.fn(async () => undefined);
		const ctx = {
			hasUI: true,
			cwd: process.cwd(),
			ui: { custom },
			sessionManager: {
				getCwd: () => process.cwd(),
				getSessionName: () => "fallback",
			},
		} as unknown as ExtensionContext;

		await sessionStartHandler({}, ctx);
		await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

		expect(custom).toHaveBeenCalledTimes(1);
	});
});
