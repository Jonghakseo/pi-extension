import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import autoSessionName from "./index.ts";
import { SUBAGENT_SESSION_DIR } from "./utils/auto-name-utils.ts";
import { generateShortLabel } from "./utils/short-label.js";
import { NAME_STATUS_KEY } from "./utils/status-keys.ts";

vi.mock("./utils/short-label.js", () => ({
	generateShortLabel: vi.fn(),
}));

describe("auto-name extension", () => {
	beforeEach(() => {
		vi.mocked(generateShortLabel).mockReset();
	});

	it("detects and applies a session name from the first user prompt", async () => {
		vi.mocked(generateShortLabel).mockResolvedValue("Release prep");
		const apiMock = createExtensionApiMock();
		autoSessionName(apiMock.api);

		const beforeAgentStart = apiMock.getHandlers("before_agent_start")[0];
		const sessionStart = apiMock.getHandlers("session_start")[0];
		if (!beforeAgentStart || !sessionStart) throw new Error("required handlers are missing");

		const setStatus = vi.fn();
		const setTitle = vi.fn();
		const ctx = {
			hasUI: true,
			ui: { setStatus, setTitle },
			sessionManager: {
				getSessionFile: () => "/tmp/root/session.json",
			},
		} as unknown as ExtensionContext;

		await beforeAgentStart({ prompt: "Ship the next release" }, ctx);
		await Promise.resolve();
		await Promise.resolve();
		await sessionStart({}, ctx);

		expect(generateShortLabel).toHaveBeenCalledTimes(1);
		expect(apiMock.getSessionName()).toBe("Release prep");
		expect(setStatus).toHaveBeenCalledWith(NAME_STATUS_KEY, "Release prep");
		expect(setTitle).toHaveBeenCalledWith(`π - Release prep - ${path.basename(process.cwd())}`);
	});

	it("skips auto naming for subagent sessions, existing names, and blank prompts", async () => {
		const apiMock = createExtensionApiMock("Existing name");
		autoSessionName(apiMock.api);
		const beforeAgentStart = apiMock.getHandlers("before_agent_start")[0];
		if (!beforeAgentStart) throw new Error("before_agent_start handler missing");

		await beforeAgentStart({ prompt: "Name me" }, {
			hasUI: true,
			ui: { setStatus: vi.fn(), setTitle: vi.fn() },
			sessionManager: {
				getSessionFile: () => `${SUBAGENT_SESSION_DIR}/child/session.json`,
			},
		} as unknown as ExtensionContext);
		await beforeAgentStart({ prompt: "Name me again" }, {
			hasUI: true,
			ui: { setStatus: vi.fn(), setTitle: vi.fn() },
			sessionManager: {
				getSessionFile: () => "/tmp/root/session.json",
			},
		} as unknown as ExtensionContext);
		apiMock.setSessionName("");
		await beforeAgentStart({ prompt: "   " }, {
			hasUI: true,
			ui: { setStatus: vi.fn(), setTitle: vi.fn() },
			sessionManager: {
				getSessionFile: () => "/tmp/root/session.json",
			},
		} as unknown as ExtensionContext);
		await Promise.resolve();

		expect(generateShortLabel).not.toHaveBeenCalled();
		expect(apiMock.getSessionName()).toBe("");
	});

	it("swallows name-generation failures and clears status when the name disappears", async () => {
		vi.mocked(generateShortLabel).mockRejectedValue(new Error("boom"));
		const apiMock = createExtensionApiMock();
		autoSessionName(apiMock.api);

		const beforeAgentStart = apiMock.getHandlers("before_agent_start")[0];
		const sessionTree = apiMock.getHandlers("session_tree")[0];
		const sessionShutdown = apiMock.getHandlers("session_shutdown")[0];
		if (!beforeAgentStart || !sessionTree || !sessionShutdown) throw new Error("required handlers are missing");

		const setStatus = vi.fn();
		const setTitle = vi.fn();
		const ctx = {
			hasUI: true,
			ui: { setStatus, setTitle },
			sessionManager: {
				getSessionFile: () => "/tmp/root/session.json",
			},
		} as unknown as ExtensionContext;

		await beforeAgentStart({ prompt: "Will fail" }, ctx);
		await Promise.resolve();
		apiMock.setSessionName("");
		await sessionTree({}, ctx);
		await sessionShutdown({}, ctx);

		expect(apiMock.getSessionName()).toBe("");
		expect(setStatus).toHaveBeenCalledWith(NAME_STATUS_KEY, undefined);
		expect(setTitle).not.toHaveBeenCalled();
	});
});
