import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import ccSystemPrompt, {
	buildClaudeCodePrompt,
	hasInjectedReminder,
	MODEL_PREFIX,
	REMINDER_CUSTOM_TYPE,
	REMINDER_MARKER,
	shouldApply,
} from "./index.ts";

describe("cc-system-prompt extension", () => {
	it("applies to all claude models", () => {
		expect(shouldApply(`${MODEL_PREFIX}opus-4-1`)).toBe(true);
		expect(shouldApply("claude-sonnet-4-0")).toBe(true);
		expect(shouldApply("gpt-5.4")).toBe(false);
		expect(shouldApply()).toBe(false);
	});

	it("replaces the system prompt and injects a reminder once", async () => {
		const apiMock = createExtensionApiMock();
		ccSystemPrompt(apiMock.api);
		const beforeAgentStart = apiMock.getHandlers("before_agent_start")[0];
		if (!beforeAgentStart) throw new Error("before_agent_start handler missing");

		const ctx = {
			model: {
				id: `${MODEL_PREFIX}opus-4-1`,
				provider: "anthropic",
			},
			sessionManager: {
				getEntries: () => [],
			},
		} as unknown as ExtensionContext;

		const result = await beforeAgentStart({ systemPrompt: "Original pi prompt" }, ctx);

		expect(result).toMatchObject({
			systemPrompt: buildClaudeCodePrompt(),
		});
		expect(apiMock.sentMessages).toHaveLength(1);
		expect(apiMock.sentMessages[0]).toMatchObject({
			customType: REMINDER_CUSTOM_TYPE,
			display: true,
			details: {
				appliesToModelPrefix: MODEL_PREFIX,
				provider: "anthropic",
				model: `${MODEL_PREFIX}opus-4-1`,
			},
		});
		expect(apiMock.sentMessages[0]).toMatchObject({
			content: expect.stringContaining(REMINDER_MARKER),
		});
	});

	it("does not inject a duplicate reminder when one already exists", async () => {
		const apiMock = createExtensionApiMock();
		ccSystemPrompt(apiMock.api);
		const beforeAgentStart = apiMock.getHandlers("before_agent_start")[0];
		if (!beforeAgentStart) throw new Error("before_agent_start handler missing");

		const entries = [
			{
				type: "custom_message",
				customType: REMINDER_CUSTOM_TYPE,
				content: `${REMINDER_MARKER}\n<system-reminder>already here</system-reminder>`,
			},
		];

		const result = await beforeAgentStart({ systemPrompt: "Original pi prompt" }, {
			model: { id: `${MODEL_PREFIX}sonnet-4-0`, provider: "anthropic" },
			sessionManager: { getEntries: () => entries },
		} as unknown as ExtensionContext);

		expect(hasInjectedReminder(entries)).toBe(true);
		expect(apiMock.sentMessages).toHaveLength(0);
		expect(result).toMatchObject({
			systemPrompt: buildClaudeCodePrompt(),
		});
	});

	it("leaves non-target models untouched", async () => {
		const apiMock = createExtensionApiMock();
		ccSystemPrompt(apiMock.api);
		const beforeAgentStart = apiMock.getHandlers("before_agent_start")[0];
		if (!beforeAgentStart) throw new Error("before_agent_start handler missing");

		const result = await beforeAgentStart({ systemPrompt: "Original pi prompt" }, {
			model: { id: "gpt-5.4", provider: "openai-codex" },
			sessionManager: { getEntries: () => [] },
		} as unknown as ExtensionContext);

		expect(result).toBeUndefined();
		expect(apiMock.sentMessages).toHaveLength(0);
	});

	it("builds a cleaned vendored prompt", () => {
		const prompt = buildClaudeCodePrompt();

		expect(prompt).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(prompt).not.toContain("ccVersion:");
		expect(prompt).not.toContain("$" + "{EXIT_PLAN_MODE_TOOL_NAME}");
	});
});
