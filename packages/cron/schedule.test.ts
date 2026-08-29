import { describe, expect, it } from "vitest";
import { calculateNextRun, isDue, matchesCron, nextCronRun, validateCron } from "./schedule.js";
import type { CronJob } from "./types.js";

describe("cron schedule parser", () => {
	it("matches wildcard cron expressions", () => {
		const date = new Date("2026-04-30T10:15:00");
		expect(matchesCron("* * * * *", date)).toBe(true);
		expect(matchesCron("15 10 * * *", date)).toBe(true);
		expect(matchesCron("16 10 * * *", date)).toBe(false);
	});

	it("supports ranges, lists, and steps", () => {
		const monday = new Date("2026-05-04T09:30:00");
		expect(matchesCron("*/15 9-10 * 5 1,3,5", monday)).toBe(true);
		expect(matchesCron("*/20 9-10 * 5 1,3,5", monday)).toBe(false);
		expect(matchesCron("30 8-9 * 5 1-5", monday)).toBe(true);
	});

	it("validates malformed cron expressions", () => {
		expect(validateCron("0 9 * * *")).toBeNull();
		expect(validateCron("0 24 * * *")).toContain("out of range");
		expect(validateCron("0 9 * *")).toContain("expected 5 fields");
		expect(validateCron("*/0 9 * * *")).toContain("Invalid step");
	});

	it("calculates the next cron run after the current minute", () => {
		const next = nextCronRun("16 10 * * *", new Date("2026-04-30T10:15:10"));
		expect(next.toISOString()).toBe(new Date("2026-04-30T10:16:00").toISOString());
	});

	it("rolls next cron run to the next day", () => {
		const next = nextCronRun("0 9 * * *", new Date("2026-04-30T10:15:00"));
		expect(next.toISOString()).toBe(new Date("2026-05-01T09:00:00").toISOString());
	});
});

describe("job next-run calculation", () => {
	it("returns undefined for disabled jobs", () => {
		expect(calculateNextRun({ enabled: false, kind: "cron", schedule: "* * * * *" })).toBeUndefined();
	});

	it("returns an ISO timestamp for at jobs", () => {
		const runAt = "2026-05-01T00:00:00.000Z";
		expect(calculateNextRun({ enabled: true, kind: "at", runAt })).toBe(runAt);
	});

	it("throws for missing cron schedule", () => {
		expect(() => calculateNextRun({ enabled: true, kind: "cron" })).toThrow("requires schedule");
	});

	it("detects due jobs by nextRunAt", () => {
		const job = {
			enabled: true,
			nextRunAt: "2026-05-01T00:00:00.000Z",
		} as CronJob;
		expect(isDue(job, new Date("2026-05-01T00:00:00.000Z"))).toBe(true);
		expect(isDue(job, new Date("2026-04-30T23:59:59.000Z"))).toBe(false);
	});
});
