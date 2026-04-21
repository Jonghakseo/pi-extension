import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import claudeSpinner from "./index.ts";

describe("claude-spinner extension", () => {
	it("sets the custom working indicator on session start", async () => {
		const apiMock = createExtensionApiMock();
		claudeSpinner(apiMock.api);

		const sessionStart = apiMock.getHandlers("session_start")[0];
		if (!sessionStart) throw new Error("session_start handler is missing");

		const setWorkingIndicator = vi.fn();
		const ctx = {
			hasUI: true,
			ui: {
				setWorkingIndicator,
				theme: {
					fg: (_color: string, text: string) => `[${text}]`,
				},
			},
		} as unknown as ExtensionContext;

		await sessionStart({}, ctx);

		expect(setWorkingIndicator).toHaveBeenCalledWith({
			frames: ["[·]", "[✻]", "[✽]", "[✶]", "[✳]", "[✢]"],
			intervalMs: 120,
		});
	});

	it("does nothing when UI is unavailable", async () => {
		const apiMock = createExtensionApiMock();
		claudeSpinner(apiMock.api);

		const sessionStart = apiMock.getHandlers("session_start")[0];
		if (!sessionStart) throw new Error("session_start handler is missing");

		await expect(sessionStart({}, { hasUI: false } as ExtensionContext)).resolves.toBeUndefined();
	});
});
