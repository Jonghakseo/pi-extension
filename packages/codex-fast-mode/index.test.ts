import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
	streamSimpleOpenAICodexResponses: vi.fn(),
}));

import { readFileSync, writeFileSync } from "node:fs";
import { streamSimpleOpenAICodexResponses } from "@mariozechner/pi-ai";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import codexFastMode, { loadCodexFastModeState, SUPPORTED_MODEL_ID, shouldUseCodexFastBadge } from "./index.ts";

describe("codex fast mode", () => {
	beforeEach(() => {
		vi.mocked(readFileSync).mockReset();
		vi.mocked(writeFileSync).mockReset();
		vi.mocked(streamSimpleOpenAICodexResponses).mockReset();
	});

	it("falls back to disabled state when state file is missing", () => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("missing");
		});

		expect(loadCodexFastModeState()).toEqual({ enabled: false });
		expect(shouldUseCodexFastBadge("openai-codex", SUPPORTED_MODEL_ID)).toBe(false);
	});

	it("uses the persisted enabled state for badge rendering", () => {
		vi.mocked(readFileSync).mockReturnValue('{"enabled":true}');

		expect(loadCodexFastModeState()).toEqual({ enabled: true });
		expect(shouldUseCodexFastBadge("openai-codex", SUPPORTED_MODEL_ID)).toBe(true);
		expect(shouldUseCodexFastBadge("openai", SUPPORTED_MODEL_ID)).toBe(false);
	});

	it("registers the command and persists toggles", async () => {
		vi.mocked(readFileSync).mockReturnValue('{"enabled":false}');
		const apiMock = createExtensionApiMock();
		codexFastMode(apiMock.api);

		const command = apiMock.getCommand("codex-fast");
		const notify = vi.fn();
		await command.handler("on", {
			hasUI: true,
			ui: { notify },
		} as unknown as ExtensionContext);

		expect(writeFileSync).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			`Codex Fast Mode enabled (openai-codex/${SUPPORTED_MODEL_ID} → text.verbosity=low + service_tier=priority)`,
			"info",
		);
	});

	it("wraps the upstream codex payload with low verbosity", async () => {
		vi.mocked(readFileSync).mockReturnValue('{"enabled":true}');
		vi.mocked(streamSimpleOpenAICodexResponses).mockResolvedValue("stream-result" as never);
		const apiMock = createExtensionApiMock();
		codexFastMode(apiMock.api);

		const provider = apiMock.getProvider("openai-codex");
		const options = {
			onPayload: vi.fn(async (payload: unknown) => payload),
		};
		const result = await provider.streamSimple(
			{ provider: "openai-codex", id: SUPPORTED_MODEL_ID },
			{ messages: [] },
			options,
		);

		expect(result).toBe("stream-result");
		expect(streamSimpleOpenAICodexResponses).toHaveBeenCalledTimes(1);
		const handler = vi.mocked(streamSimpleOpenAICodexResponses).mock.calls[0]?.[2]?.onPayload;
		if (typeof handler !== "function") throw new Error("onPayload handler missing");
		const onPayload = handler as unknown as (payload: unknown, model: unknown) => Promise<unknown>;
		const payload = await onPayload(
			{ text: { format: "plain" } },
			{ provider: "openai-codex", id: SUPPORTED_MODEL_ID },
		);
		expect(payload).toMatchObject({
			text: { format: "plain", verbosity: "low" },
			service_tier: "priority",
		});
	});

	it("handles help, status, off, and completion filtering", async () => {
		vi.mocked(readFileSync).mockReturnValue('{"enabled":false}');
		const apiMock = createExtensionApiMock();
		codexFastMode(apiMock.api);

		const command = apiMock.getCommand("codex-fast");
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { notify } } as unknown as ExtensionContext;

		expect(command.getArgumentCompletions?.("st")).toEqual([{ value: "status", label: "status" }]);
		expect(command.getArgumentCompletions?.("zzz")).toBeNull();

		await command.handler("", ctx);
		await command.handler("bogus", ctx);
		await command.handler("status", ctx);
		await command.handler("off", ctx);
		await command.handler("on", { hasUI: false } as unknown as ExtensionContext);
		await command.handler("status", { hasUI: false } as unknown as ExtensionContext);
		await command.handler("bogus", { hasUI: false } as unknown as ExtensionContext);

		expect(notify).toHaveBeenCalledWith("Usage: /codex-fast [on|off|status]", "info");
		expect(notify).toHaveBeenCalledWith(
			`Codex Fast Mode: OFF (always force text.verbosity=low; inject service_tier=priority when ON for openai-codex/${SUPPORTED_MODEL_ID})`,
			"info",
		);
		expect(notify).toHaveBeenCalledWith(
			`Codex Fast Mode disabled (text.verbosity=low still applies for openai-codex/${SUPPORTED_MODEL_ID})`,
			"info",
		);
	});

	it("shows the enabled status message when persisted state is on", async () => {
		vi.mocked(readFileSync).mockReturnValue('{"enabled":true}');
		const apiMock = createExtensionApiMock();
		codexFastMode(apiMock.api);

		const notify = vi.fn();
		await apiMock.getCommand("codex-fast").handler("status", {
			hasUI: true,
			ui: { notify },
		} as unknown as ExtensionContext);

		expect(notify).toHaveBeenCalledWith(
			`Codex Fast Mode: ON (always force text.verbosity=low; inject service_tier=priority when ON for openai-codex/${SUPPORTED_MODEL_ID})`,
			"info",
		);
	});

	it("passes through unsupported payload shapes and models", async () => {
		vi.mocked(readFileSync).mockReturnValue('{"enabled":false}');
		vi.mocked(streamSimpleOpenAICodexResponses).mockResolvedValue("stream-result" as never);
		const apiMock = createExtensionApiMock();
		codexFastMode(apiMock.api);

		const provider = apiMock.getProvider("openai-codex");
		await provider.streamSimple({ provider: "openai-codex", id: SUPPORTED_MODEL_ID }, { messages: [] }, {});
		const handler = vi.mocked(streamSimpleOpenAICodexResponses).mock.calls[0]?.[2]?.onPayload;
		if (typeof handler !== "function") throw new Error("onPayload handler missing");
		const onPayload = handler as unknown as (payload: unknown, model: unknown) => Promise<unknown>;

		await expect(onPayload("raw", { provider: "openai-codex", id: SUPPORTED_MODEL_ID })).resolves.toBe("raw");
		await expect(onPayload({ text: {} }, { provider: "other", id: SUPPORTED_MODEL_ID })).resolves.toEqual({ text: {} });
		await expect(onPayload({ text: {} }, { provider: "openai-codex", id: "other-model" })).resolves.toEqual({
			text: {},
		});
		await expect(onPayload({ text: {} }, { provider: "openai-codex", id: SUPPORTED_MODEL_ID })).resolves.toEqual({
			text: { verbosity: "low" },
		});
		await expect(onPayload({ text: "plain" }, { provider: "openai-codex", id: SUPPORTED_MODEL_ID })).resolves.toEqual({
			text: { verbosity: "low" },
		});
		vi.mocked(streamSimpleOpenAICodexResponses).mockReset();
		await provider.streamSimple(
			{ provider: "openai-codex", id: SUPPORTED_MODEL_ID },
			{ messages: [] },
			{
				onPayload: async () => null,
			},
		);
		const nullHandler = vi.mocked(streamSimpleOpenAICodexResponses).mock.calls[0]?.[2]?.onPayload;
		if (typeof nullHandler !== "function") throw new Error("onPayload handler missing");
		const onPayloadWithNull = nullHandler as unknown as (payload: unknown, model: unknown) => Promise<unknown>;
		await expect(
			onPayloadWithNull({ text: {} }, { provider: "openai-codex", id: SUPPORTED_MODEL_ID }),
		).resolves.toEqual({
			text: { verbosity: "low" },
		});
	});
});
