/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { afterEach, describe, expect, it } from "vitest";
import {
	CONTEXT_GUARD_SIGNATURE,
	isContextOverflowText,
	resolveContextGuardCeiling,
	shouldTripContextGuard,
} from "./context-limits.ts";

const ENV_KEY = "PI_SUBAGENT_CONTEXT_GUARD_TOKENS";

afterEach(() => {
	delete process.env[ENV_KEY];
});

describe("isContextOverflowText", () => {
	it("matches provider overflow errors", () => {
		expect(isContextOverflowText("Your input exceeds the context window of this model")).toBe(true);
		expect(isContextOverflowText("prompt is too long: 213462 tokens > 200000 maximum")).toBe(true);
		expect(isContextOverflowText("Input length (265330) exceeds model's maximum context length (262144).")).toBe(true);
		expect(isContextOverflowText("context_length_exceeded")).toBe(true);
	});

	it("matches our own proactive guard signature", () => {
		expect(isContextOverflowText(`${CONTEXT_GUARD_SIGNATURE} stopped at 235100 tokens (ceiling 235000)`)).toBe(true);
	});

	it("excludes rate-limit / throttling errors", () => {
		expect(isContextOverflowText("rate limit exceeded")).toBe(false);
		expect(isContextOverflowText("Throttling error: Too many tokens, please wait")).toBe(false);
		expect(isContextOverflowText("429 too many requests")).toBe(false);
	});

	it("returns false for empty / unrelated text", () => {
		expect(isContextOverflowText("")).toBe(false);
		expect(isContextOverflowText(undefined)).toBe(false);
		expect(isContextOverflowText("some normal assistant output")).toBe(false);
	});
});

describe("shouldTripContextGuard", () => {
	it("does not trip for terminal assistant stop reasons", () => {
		for (const stopReason of ["stop", "length", "error", "aborted", undefined]) {
			expect(
				shouldTripContextGuard({
					stopReason,
					peakContextTokens: 235_000,
					ceiling: 235_000,
					alreadyTripped: false,
				}),
			).toBe(false);
		}
	});

	it("trips for toolUse when peak tokens reach or exceed the ceiling", () => {
		expect(
			shouldTripContextGuard({
				stopReason: "toolUse",
				peakContextTokens: 235_001,
				ceiling: 235_000,
				alreadyTripped: false,
			}),
		).toBe(true);
		expect(
			shouldTripContextGuard({
				stopReason: "toolUse",
				peakContextTokens: 235_000,
				ceiling: 235_000,
				alreadyTripped: false,
			}),
		).toBe(true);
	});

	it("does not trip when already tripped or no ceiling applies", () => {
		expect(
			shouldTripContextGuard({
				stopReason: "toolUse",
				peakContextTokens: 235_001,
				ceiling: 235_000,
				alreadyTripped: true,
			}),
		).toBe(false);
		expect(
			shouldTripContextGuard({
				stopReason: "toolUse",
				peakContextTokens: 235_001,
				ceiling: undefined,
				alreadyTripped: false,
			}),
		).toBe(false);
	});

	it("does not trip below the ceiling", () => {
		expect(
			shouldTripContextGuard({
				stopReason: "toolUse",
				peakContextTokens: 234_999,
				ceiling: 235_000,
				alreadyTripped: false,
			}),
		).toBe(false);
	});
});

describe("resolveContextGuardCeiling", () => {
	it("applies a 115k ceiling to GPT-5.3 Codex Spark", () => {
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.3-codex-spark", "pi")).toBe(115_000);
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.3-codex-spark", undefined)).toBe(115_000);
	});

	it("applies a 335k ceiling to the GPT-5.6 Codex family", () => {
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.6-sol", "pi")).toBe(335_000);
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.6-terra", undefined)).toBe(335_000);
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.6-luna", "pi")).toBe(335_000);
	});

	it("keeps the 235k ceiling for whitelisted 272k Codex models", () => {
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.5", "pi")).toBe(235_000);
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.5", undefined)).toBe(235_000);
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.4", "pi")).toBe(235_000);
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.4-mini", "pi")).toBe(235_000);
	});

	it("returns undefined for unknown models, unlisted codex models, and non-pi runtimes", () => {
		expect(resolveContextGuardCeiling("anthropic/claude-opus-4-6", "pi")).toBeUndefined();
		expect(resolveContextGuardCeiling("openai-codex/gpt-6-future", "pi")).toBeUndefined();
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.6-sol", "claude")).toBeUndefined();
		expect(resolveContextGuardCeiling(undefined, "pi")).toBeUndefined();
	});

	it("honors an env override for all pi models", () => {
		process.env[ENV_KEY] = "120000";
		expect(resolveContextGuardCeiling("anthropic/claude-opus-4-6", "pi")).toBe(120_000);
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.6-sol", "pi")).toBe(120_000);
	});

	it("disables the guard when env override is 0 or invalid", () => {
		process.env[ENV_KEY] = "0";
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.6-sol", "pi")).toBeUndefined();
		process.env[ENV_KEY] = "not-a-number";
		expect(resolveContextGuardCeiling("openai-codex/gpt-5.6-sol", "pi")).toBeUndefined();
	});
});
