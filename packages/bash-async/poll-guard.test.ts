import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLL_COOLDOWN_MS, PollGuard } from "./poll-guard.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("PollGuard", () => {
	it("blocks unchanged repeats within the cooldown and reports the remaining wait", () => {
		let now = 1_000;
		const guard = new PollGuard({ now: () => now, cooldownMs: 10_000 });
		expect(guard.check("status:a", "running")).toEqual({ allowed: true });
		now += 1_000;
		expect(guard.check("status:a", "running")).toEqual({ allowed: false, retryInMs: 9_000 });
		now += 1_000;
		expect(guard.check("status:a", "running")).toEqual({ allowed: false, retryInMs: 8_000 });
		now += 8_000;
		expect(guard.check("status:a", "running")).toEqual({ allowed: true });
	});

	it("blocks alternating signatures so a caller cannot take turns to evade the limit", () => {
		let now = 0;
		const guard = new PollGuard({ now: () => now, cooldownMs: 10_000 });
		expect(guard.check("output:a", "0:3")).toEqual({ allowed: true });
		now += 1_000;
		expect(guard.check("output:a", "0:1")).toEqual({ allowed: true });
		now += 1_000;
		expect(guard.check("output:a", "0:3")).toEqual({ allowed: false, retryInMs: 8_000 });
		expect(guard.check("output:a", "0:1")).toEqual({ allowed: false, retryInMs: 9_000 });
	});

	it("allows a new signature, a different key, and any query once the cooldown expires", () => {
		let now = 0;
		const guard = new PollGuard({ now: () => now, cooldownMs: 5_000 });
		guard.check("output:a", "0:0");
		expect(guard.check("output:a", "0:8")).toEqual({ allowed: true });
		expect(guard.check("output:b", "0:0")).toEqual({ allowed: true });
		expect(guard.check("output:a", "0:8")).toEqual({ allowed: false, retryInMs: 5_000 });
		now += 5_000;
		expect(guard.check("output:a", "0:8")).toEqual({ allowed: true });
	});

	it("forgets one key, clears every key, and drops entries older than the cooldown", () => {
		let now = 0;
		const guard = new PollGuard({ now: () => now, cooldownMs: 5_000 });
		guard.check("status:a", "running");
		guard.check("list", "a:running");
		expect(guard.check("status:a", "running")).toEqual({ allowed: false, retryInMs: 5_000 });
		guard.forget("status:a");
		expect(guard.check("status:a", "running")).toEqual({ allowed: true });
		expect(guard.check("list", "a:running")).toEqual({ allowed: false, retryInMs: 5_000 });
		guard.clear();
		expect(guard.check("list", "a:running")).toEqual({ allowed: true });

		now += 5_000;
		guard.check("status:a", "running");
		expect(guard.entryCount()).toBe(1);
	});

	it("reads the cooldown from the environment and falls back to the default for invalid values", () => {
		vi.stubEnv("PI_BASH_ASYNC_POLL_COOLDOWN_MS", "0");
		const disabled = new PollGuard({ now: () => 0 });
		disabled.check("list", "same");
		expect(disabled.check("list", "same")).toEqual({ allowed: true });

		vi.stubEnv("PI_BASH_ASYNC_POLL_COOLDOWN_MS", "nonsense");
		const fallback = new PollGuard({ now: () => 0 });
		fallback.check("list", "same");
		expect(fallback.check("list", "same")).toEqual({ allowed: false, retryInMs: DEFAULT_POLL_COOLDOWN_MS });
	});
});
