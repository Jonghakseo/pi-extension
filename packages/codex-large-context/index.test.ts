import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import codexLargeContext, {
	applyLargeContext,
	isCodexLargeContextEnabled,
	isTargetModelId,
	loadCodexLargeContextState,
	TARGET_CONTEXT_WINDOW,
	TARGET_MODEL_PREFIXES,
} from "./index.ts";

const makeContext = (overrides: Record<string, unknown> = {}): ExtensionContext =>
	({
		hasUI: false,
		...overrides,
	}) as unknown as ExtensionContext;

const useDefaultEnabledState = () => {
	vi.mocked(readFileSync).mockImplementation(() => {
		throw new Error("missing");
	});
};

describe("codex large context", () => {
	beforeEach(() => {
		vi.mocked(mkdirSync).mockReset();
		vi.mocked(readFileSync).mockReset();
		vi.mocked(writeFileSync).mockReset();
		useDefaultEnabledState();
	});

	it("defaults to enabled when the state file is missing or corrupt", () => {
		expect(loadCodexLargeContextState()).toEqual({ enabled: true });
		expect(isCodexLargeContextEnabled()).toBe(true);

		vi.mocked(readFileSync).mockReturnValue("not json");
		expect(loadCodexLargeContextState()).toEqual({ enabled: true });
	});

	it("loads the persisted disabled state", () => {
		vi.mocked(readFileSync).mockReturnValue('{"enabled":false}');

		expect(loadCodexLargeContextState()).toEqual({ enabled: false });
		expect(isCodexLargeContextEnabled()).toBe(false);
	});

	it("detects supported Codex model prefixes", () => {
		expect(isTargetModelId(TARGET_MODEL_PREFIXES[0])).toBe(true);
		expect(isTargetModelId(`${TARGET_MODEL_PREFIXES[1]}-preview`)).toBe(true);
		expect(isTargetModelId("gpt-5.3")).toBe(false);
		expect(isTargetModelId(undefined)).toBe(false);
	});

	it("registers model/session event handlers and the command", () => {
		const apiMock = createExtensionApiMock();
		codexLargeContext(apiMock.api);

		expect(apiMock.getHandlers("model_select")).toHaveLength(1);
		expect(apiMock.getHandlers("session_start")).toHaveLength(1);
		expect(apiMock.getCommand("codex-large-context")).toBeDefined();
	});

	it("expands the context window for target models and notifies in UI mode", async () => {
		const apiMock = createExtensionApiMock();
		const setModel = vi.fn(async () => true);
		apiMock.api.setModel = setModel;
		const notify = vi.fn();

		const result = await applyLargeContext(
			apiMock.api,
			makeContext({
				hasUI: true,
				ui: { notify },
				model: {
					id: "gpt-5.4",
					contextWindow: 128_000,
				},
			}),
		);

		expect(result).toBe(true);
		expect(setModel).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "gpt-5.4",
				contextWindow: TARGET_CONTEXT_WINDOW,
			}),
		);
		expect(notify).toHaveBeenCalledWith("gpt-5.4 context window: 128K → 922K", "info");
	});

	it("skips disabled, missing, unsupported, and already-expanded models", async () => {
		const apiMock = createExtensionApiMock();
		const setModel = vi.fn(async () => true);
		apiMock.api.setModel = setModel;

		vi.mocked(readFileSync).mockReturnValue('{"enabled":false}');
		await expect(
			applyLargeContext(apiMock.api, makeContext({ model: { id: "gpt-5.4", contextWindow: 128_000 } })),
		).resolves.toBe(false);

		useDefaultEnabledState();
		await expect(applyLargeContext(apiMock.api, makeContext())).resolves.toBe(false);
		await expect(
			applyLargeContext(apiMock.api, makeContext({ model: { id: "gpt-5.3", contextWindow: 128_000 } })),
		).resolves.toBe(false);
		await expect(
			applyLargeContext(apiMock.api, makeContext({ model: { id: "gpt-5.5", contextWindow: TARGET_CONTEXT_WINDOW } })),
		).resolves.toBe(false);

		expect(setModel).not.toHaveBeenCalled();
	});

	it("does not notify when setModel fails or UI is unavailable", async () => {
		const apiMock = createExtensionApiMock();
		const setModel = vi.fn(async () => false);
		apiMock.api.setModel = setModel;
		const notify = vi.fn();

		await expect(
			applyLargeContext(
				apiMock.api,
				makeContext({
					hasUI: true,
					ui: { notify },
					model: { id: "gpt-5.5", contextWindow: 128_000 },
				}),
			),
		).resolves.toBe(false);
		expect(notify).not.toHaveBeenCalled();

		setModel.mockResolvedValueOnce(true);
		await expect(
			applyLargeContext(apiMock.api, makeContext({ model: { id: "gpt-5.5", contextWindow: 128_000 } })),
		).resolves.toBe(true);
		expect(notify).not.toHaveBeenCalled();
	});

	it("handles command completions, help, status, and toggles", async () => {
		const apiMock = createExtensionApiMock();
		const setModel = vi.fn(async () => true);
		apiMock.api.setModel = setModel;
		codexLargeContext(apiMock.api);

		const command = apiMock.getCommand("codex-large-context");
		const notify = vi.fn();
		const ctx = makeContext({
			hasUI: true,
			ui: { notify },
			model: { id: "gpt-5.4", contextWindow: 128_000 },
		});

		expect(command.getArgumentCompletions?.("st")).toEqual([{ value: "status", label: "status" }]);
		expect(command.getArgumentCompletions?.("zzz")).toBeNull();

		vi.mocked(readFileSync).mockReturnValue('{"enabled":true}');
		await command.handler("", ctx);
		await command.handler("bogus", ctx);
		await command.handler("off", ctx);
		await command.handler("on", ctx);

		expect(notify).toHaveBeenCalledWith("Codex Large Context: ON (gpt-5.4 or gpt-5.5 → 922K)", "info");
		expect(notify).toHaveBeenCalledWith("Usage: /codex-large-context [on|off|status]", "info");
		expect(notify).toHaveBeenCalledWith("Codex Large Context disabled", "info");
		expect(notify).toHaveBeenCalledWith("Codex Large Context enabled (gpt-5.4 or gpt-5.5 → 922K)", "info");
		expect(mkdirSync).toHaveBeenCalledTimes(2);
		expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), '{\n  "enabled": false\n}\n', "utf8");
		expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), '{\n  "enabled": true\n}\n', "utf8");
		expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: TARGET_CONTEXT_WINDOW }));
	});

	it("does not notify for commands when UI is unavailable", async () => {
		const apiMock = createExtensionApiMock();
		codexLargeContext(apiMock.api);

		const command = apiMock.getCommand("codex-large-context");
		await command.handler("status", makeContext({ hasUI: false }));
		await command.handler("bogus", makeContext({ hasUI: false }));
		await command.handler("off", makeContext({ hasUI: false }));

		expect(writeFileSync).toHaveBeenCalledTimes(1);
	});
});
