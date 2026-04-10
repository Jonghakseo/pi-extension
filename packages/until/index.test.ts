import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import untilExtension, { parseInterval } from "./index.ts";

describe("until extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("parses supported interval formats", () => {
		expect(parseInterval("5m")).toEqual({ ms: 5 * 60_000, label: "5분" });
		expect(parseInterval("1시간마다")).toEqual({ ms: 60 * 60_000, label: "1시간" });
		expect(parseInterval("2분")).toEqual({ ms: 2 * 60_000, label: "2분" });
		expect(parseInterval("0분")).toBeNull();
		expect(parseInterval("soon")).toBeNull();
	});

	it("registers, repeats, and completes until tasks", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);

		const notify = vi.fn();
		const setStatus = vi.fn();
		const ctx = {
			hasUI: true,
			ui: {
				notify,
				setStatus,
				theme: {
					fg: (_color: string, text: string) => text,
					bg: (_color: string, text: string) => text,
				},
			},
		} as unknown as ExtensionContext;

		await apiMock.getCommand("until").handler("1분 배포 상태 확인", ctx);
		expect(apiMock.sentMessages).toHaveLength(1);
		expect(apiMock.sentMessages[0]).toMatchObject({
			customType: "until",
			content: expect.stringContaining("[until #1] 등록됨: 1분마다 반복"),
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(apiMock.sentMessages).toHaveLength(2);
		expect(apiMock.sentMessages[1]).toMatchObject({
			customType: "until-prompt",
			content: expect.stringContaining("작업을 수행한 뒤, 반드시 until_report 도구를 호출하여 결과를 보고하세요."),
			details: expect.objectContaining({
				taskId: 1,
				runCount: 1,
				intervalLabel: "1분",
				displayPrompt: "배포 상태 확인",
			}),
		});

		const tool = apiMock.getTool("until_report");
		const execute = tool.execute;
		if (!execute) throw new Error("until_report execute is missing");

		const keepGoing = await execute(
			"call-1",
			{ taskId: 1, done: false, summary: "아직 배포 중" },
			undefined,
			undefined,
			ctx,
		);
		expect(keepGoing).toMatchObject({
			details: { done: false, summary: "아직 배포 중", taskId: 1, runCount: 1 },
		});

		await apiMock.getCommand("untils").handler("", ctx);
		expect(apiMock.sentMessages[2]).toMatchObject({
			customType: "until",
			content: expect.stringContaining("최근: 아직 배포 중"),
		});

		await vi.advanceTimersByTimeAsync(60_000);
		expect(apiMock.sentMessages[3]).toMatchObject({
			customType: "until-prompt",
			details: expect.objectContaining({ taskId: 1, runCount: 2 }),
		});

		const done = await execute("call-2", { taskId: 1, done: true, summary: "배포 완료" }, undefined, undefined, ctx);
		expect(done).toMatchObject({
			details: { done: true, summary: "배포 완료", taskId: 1, runCount: 2 },
		});

		await apiMock.getCommand("untils").handler("", ctx);
		expect(notify).toHaveBeenCalledWith("활성 until 작업이 없어.", "info");
	});

	it("cancels all pending until tasks", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);

		const notify = vi.fn();
		const setStatus = vi.fn();
		const ctx = {
			hasUI: true,
			ui: {
				notify,
				setStatus,
				theme: {
					fg: (_color: string, text: string) => text,
					bg: (_color: string, text: string) => text,
				},
			},
		} as unknown as ExtensionContext;

		await apiMock.getCommand("until").handler("1분 첫 번째 확인", ctx);
		await apiMock.getCommand("until").handler("2분 두 번째 확인", ctx);
		await apiMock.getCommand("until-cancel").handler("all", ctx);
		await apiMock.getCommand("untils").handler("", ctx);

		expect(notify).toHaveBeenCalledWith("until 2개 취소됨", "info");
		expect(notify).toHaveBeenCalledWith("활성 until 작업이 없어.", "info");
	});
});
