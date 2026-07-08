import { describe, expect, it } from "vitest";
import { parseDelayArgs, parseDurationMs } from "./parse.ts";

describe("delay parser", () => {
	it("parses common duration units", () => {
		expect(parseDurationMs("30s")).toBe(30_000);
		expect(parseDurationMs("5m")).toBe(300_000);
		expect(parseDurationMs("1h")).toBe(3_600_000);
		expect(parseDurationMs("1h30m")).toBe(5_400_000);
		expect(parseDurationMs("2시간")).toBe(7_200_000);
		expect(parseDurationMs("10분")).toBe(600_000);
	});

	it("rejects invalid durations", () => {
		expect(parseDurationMs("")).toBeUndefined();
		expect(parseDurationMs("5")).toBeUndefined();
		expect(parseDurationMs("soon")).toBeUndefined();
		expect(parseDurationMs("0m")).toBeUndefined();
	});

	it("parses /delay arguments", () => {
		expect(parseDelayArgs("5m 상태 확인해줘")).toEqual({
			durationText: "5m",
			delayMs: 300_000,
			prompt: "상태 확인해줘",
		});
		expect(parseDelayArgs("1h30m 배포 결과 확인")).toEqual({
			durationText: "1h30m",
			delayMs: 5_400_000,
			prompt: "배포 결과 확인",
		});
	});

	it("returns user-facing errors for missing pieces", () => {
		expect(parseDelayArgs("")).toHaveProperty("error");
		expect(parseDelayArgs("5m")).toHaveProperty("error");
		expect(parseDelayArgs("나중에 확인")).toHaveProperty("error");
	});
});
