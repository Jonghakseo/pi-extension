import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import delayedActionExtension from "./index.ts";

function createCtx(overrides: Partial<ExtensionContext> = {}) {
	return {
		hasUI: true,
		isIdle: vi.fn(() => true),
		ui: {
			theme: {},
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
		...overrides,
	} as unknown as ExtensionContext;
}

describe("delayed-action delay extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers /delay commands and delay tool", () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);

		expect(apiMock.getCommand("delay")).toBeDefined();
		expect(apiMock.getCommand("delay-cancel")).toBeDefined();
		expect(apiMock.getTool("delay")).toBeDefined();
		expect(apiMock.getHandlers("input")).toHaveLength(0);
	});

	it("schedules and fires prompts from the delay tool", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const ctx = createCtx();

		const result = await tool.execute?.(
			"call-1",
			{ delay: "10m", prompt: "배포 로그 확인해", id: "deploy-log" },
			undefined,
			undefined,
			ctx,
		);

		expect(result).toMatchObject({
			details: { id: "deploy-log", prompt: "배포 로그 확인해" },
		});
		expect(apiMock.userMessages).toHaveLength(0);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("delay", expect.stringContaining("⏰ 1"));

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

		expect(apiMock.userMessages).toEqual([{ message: "배포 로그 확인해", options: undefined }]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("⏰ deploy-log 시간이 되어 프롬프트를 실행했어요.", "info");
	});

	it("queues followUp when the agent is busy", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const ctx = createCtx({ isIdle: vi.fn(() => false) } as unknown as ExtensionContext);

		await tool.execute?.("call-1", { delay: "30s", prompt: "상태 확인" }, undefined, undefined, ctx);
		await vi.advanceTimersByTimeAsync(30 * 1000);

		expect(apiMock.userMessages).toEqual([{ message: "상태 확인", options: { deliverAs: "followUp" } }]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("⏰ delay-1 작업 중이라 followUp으로 예약했어요.", "info");
	});

	it("supports /delay list and /delay-cancel", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const delayCommand = apiMock.getCommand("delay");
		const cancelCommand = apiMock.getCommand("delay-cancel");
		const ctx = createCtx();

		await delayCommand.handler("5m 상태 확인해줘", ctx);
		const scheduleMessage = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
		const id = scheduleMessage.match(/✓ (delay-\d+) 예약됨/)?.[1];
		if (!id) throw new Error("delay id not found");

		await delayCommand.handler("list", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("예약된 delay:"), "info");

		await cancelCommand.handler(id, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(`✓ ${id} 예약을 취소했어요.`, "info");

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(apiMock.userMessages).toHaveLength(0);
	});
});
