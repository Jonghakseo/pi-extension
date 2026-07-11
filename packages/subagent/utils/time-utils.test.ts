import { describe, expect, it } from "vitest";
import {
	formatClock,
	formatDuration,
	formatDurationBetween,
	formatElapsedSince,
	formatKoreanDuration,
	formatReplayTime,
	parseDateSafely,
	toDelayMs,
	toEpochMs,
} from "./time-utils.js";

// ─── formatDuration (existing) ───────────────────────────────────────────────

describe("formatDuration", () => {
	it("returns 0초 for 0ms", () => {
		expect(formatDuration(0)).toBe("0초");
	});

	it("returns seconds only for < 1 min", () => {
		expect(formatDuration(5000)).toBe("5초");
		expect(formatDuration(59999)).toBe("59초");
	});

	it("returns minutes and seconds", () => {
		expect(formatDuration(60000)).toBe("1분 0초");
		expect(formatDuration(90000)).toBe("1분 30초");
	});

	it("returns hours, minutes, seconds", () => {
		expect(formatDuration(3661000)).toBe("1시간 1분 1초");
		expect(formatDuration(7200000)).toBe("2시간 0분 0초");
	});

	it("handles NaN as 0", () => {
		expect(formatDuration(NaN)).toBe("0초");
	});

	it("handles Infinity as 0", () => {
		expect(formatDuration(Infinity)).toBe("0초");
	});

	it("handles negative as 0", () => {
		expect(formatDuration(-5000)).toBe("0초");
	});
});

// ─── formatDurationBetween ───────────────────────────────────────────────────

describe("formatDurationBetween", () => {
	it("calculates duration between two timestamps", () => {
		const start = new Date("2026-01-01T00:00:00Z");
		const end = new Date("2026-01-01T00:01:30Z");
		expect(formatDurationBetween(start, end)).toBe("1분 30초");
	});

	it("handles numbers", () => {
		expect(formatDurationBetween(1000, 6000)).toBe("5초");
	});

	it("returns 0초 when end <= start", () => {
		expect(formatDurationBetween(5000, 1000)).toBe("0초");
	});
});

// ─── formatElapsedSince ──────────────────────────────────────────────────────

describe("formatElapsedSince", () => {
	it("calculates elapsed from a fixed now", () => {
		const startedAt = 1000;
		const now = 11000;
		expect(formatElapsedSince(startedAt, now)).toBe("10초");
	});

	it("returns 0초 for future startedAt", () => {
		expect(formatElapsedSince(10000, 5000)).toBe("0초");
	});
});

// ─── toDelayMs ───────────────────────────────────────────────────────────────

describe("toDelayMs", () => {
	it("converts seconds", () => {
		expect(toDelayMs(5, "초")).toBe(5000);
	});

	it("converts minutes", () => {
		expect(toDelayMs(3, "분")).toBe(180000);
	});

	it("converts hours", () => {
		expect(toDelayMs(2, "시간")).toBe(7200000);
	});

	it("handles zero", () => {
		expect(toDelayMs(0, "초")).toBe(0);
	});
});

// ─── formatKoreanDuration ────────────────────────────────────────────────────

describe("formatKoreanDuration", () => {
	it("formats seconds for < 1min", () => {
		expect(formatKoreanDuration(5000)).toBe("5초");
		expect(formatKoreanDuration(500)).toBe("1초");
	});

	it("formats minutes for < 1hour", () => {
		expect(formatKoreanDuration(120000)).toBe("2분");
		expect(formatKoreanDuration(600000)).toBe("10분");
	});

	it("formats hours without minutes", () => {
		expect(formatKoreanDuration(3600000)).toBe("1시간");
	});

	it("formats hours with minutes", () => {
		expect(formatKoreanDuration(3660000)).toBe("1시간 1분");
	});

	it("handles zero", () => {
		expect(formatKoreanDuration(0)).toBe("1초");
	});
});

// ─── formatClock ─────────────────────────────────────────────────────────────

describe("formatClock", () => {
	it("returns a time string", () => {
		const result = formatClock(new Date("2026-01-01T14:05:30Z").getTime());
		// Locale-dependent, just check it contains digits and colons
		expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
	});

	it("returns a string for epoch 0", () => {
		const result = formatClock(0);
		expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
	});
});

// ─── parseDateSafely ─────────────────────────────────────────────────────────

describe("parseDateSafely", () => {
	it("parses numeric timestamp", () => {
		const ts = Date.now();
		const result = parseDateSafely(ts);
		expect(result.getTime()).toBe(ts);
	});

	it("parses ISO string", () => {
		const result = parseDateSafely("2026-01-01T00:00:00Z");
		expect(result.getFullYear()).toBe(2026);
	});

	it("returns now for invalid input", () => {
		const before = Date.now();
		const result = parseDateSafely("not-a-date");
		expect(result.getTime()).toBeGreaterThanOrEqual(before - 100);
	});

	it("returns now for null", () => {
		const before = Date.now();
		const result = parseDateSafely(null);
		expect(result.getTime()).toBeGreaterThanOrEqual(before - 100);
	});

	it("returns now for undefined", () => {
		const before = Date.now();
		const result = parseDateSafely(undefined);
		expect(result.getTime()).toBeGreaterThanOrEqual(before - 100);
	});
});

// ─── formatReplayTime ────────────────────────────────────────────────────────

describe("formatReplayTime", () => {
	it("formats a date to time string", () => {
		const d = new Date("2026-01-01T14:05:30Z");
		const result = formatReplayTime(d);
		// Locale-dependent, just check format
		expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
	});
});

// ─── toEpochMs ───────────────────────────────────────────────────────────────

describe("toEpochMs", () => {
	it("returns 0 for null", () => {
		expect(toEpochMs(null)).toBe(0);
	});

	it("returns 0 for empty string", () => {
		expect(toEpochMs("")).toBe(0);
	});

	it("parses valid ISO string", () => {
		const result = toEpochMs("2026-01-01T00:00:00Z");
		expect(result).toBe(new Date("2026-01-01T00:00:00Z").getTime());
	});

	it("returns 0 for invalid date string", () => {
		expect(toEpochMs("not-a-date")).toBe(0);
	});

	it("parses partial date", () => {
		const result = toEpochMs("2026-06-15");
		expect(result).toBeGreaterThan(0);
	});
});
