import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import delayedActionExtension from "./index.ts";

function createCtx(overrides: Partial<ExtensionContext> = {}) {
	return {
		hasUI: true,
		isIdle: vi.fn(() => true),
		...overrides,
		ui: {
			theme: {},
			notify: vi.fn(),
			setStatus: vi.fn(),
			select: vi.fn(),
			input: vi.fn(),
			editor: vi.fn(),
			...overrides.ui,
		},
	} as unknown as ExtensionContext;
}

function deferred<T>() {
	let resolve: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve: (value: T) => resolve(value) };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
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
		expect(apiMock.getCommand("delay-list")).toBeDefined();
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

	it("keeps delayed prompts bound to the runtime that scheduled them", async () => {
		const mainRuntime = createExtensionApiMock();
		delayedActionExtension(mainRuntime.api);
		const mainTool = mainRuntime.getTool("delay");

		const throwawayRuntime = createExtensionApiMock();
		delayedActionExtension(throwawayRuntime.api);

		await mainTool.execute?.(
			"call-main-runtime",
			{ delay: "2s", prompt: "메인 세션에서 실행", id: "main-runtime" },
			undefined,
			undefined,
			createCtx(),
		);
		await vi.advanceTimersByTimeAsync(2_000);

		expect(mainRuntime.userMessages).toEqual([{ message: "메인 세션에서 실행", options: undefined }]);
		expect(throwawayRuntime.userMessages).toHaveLength(0);
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

	it("sends a selected delay immediately from /delay-list", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const listCommand = apiMock.getCommand("delay-list");
		const ctx = createCtx();
		const select = ctx.ui.select as ReturnType<typeof vi.fn>;
		select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		select.mockResolvedValueOnce("지금 보내기");

		await tool.execute?.(
			"call-send",
			{ delay: "5m", prompt: "바로 확인해", id: "send-now" },
			undefined,
			undefined,
			ctx,
		);
		await listCommand.handler("", ctx);

		expect(apiMock.userMessages).toEqual([{ message: "바로 확인해", options: undefined }]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("▶ send-now 프롬프트를 바로 실행했어요.", "info");

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(apiMock.userMessages).toHaveLength(1);
	});

	it("sends a selected delay as followUp when the agent is busy", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const listCommand = apiMock.getCommand("delay-list");
		const ctx = createCtx({ isIdle: vi.fn(() => false) } as unknown as ExtensionContext);
		const select = ctx.ui.select as ReturnType<typeof vi.fn>;
		select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		select.mockResolvedValueOnce("지금 보내기");

		await tool.execute?.(
			"call-send-busy",
			{ delay: "5m", prompt: "작업 뒤에 확인해", id: "send-follow-up" },
			undefined,
			undefined,
			ctx,
		);
		await listCommand.handler("", ctx);

		expect(apiMock.userMessages).toEqual([{ message: "작업 뒤에 확인해", options: { deliverAs: "followUp" } }]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("▶ send-follow-up 프롬프트를 followUp으로 바로 보냈어요.", "info");
	});

	it("edits the delay and prompt of a selected task", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const listCommand = apiMock.getCommand("delay-list");
		const ctx = createCtx();
		const select = ctx.ui.select as ReturnType<typeof vi.fn>;
		select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		select.mockResolvedValueOnce("수정");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("10m");
		(ctx.ui.editor as ReturnType<typeof vi.fn>).mockResolvedValueOnce("수정된 메시지");

		await tool.execute?.(
			"call-edit",
			{ delay: "5m", prompt: "기존 메시지", id: "edit-task" },
			undefined,
			undefined,
			ctx,
		);
		await listCommand.handler("", ctx);

		expect(ctx.ui.editor).toHaveBeenCalledWith("메시지 수정 · edit-task", "기존 메시지");
		expect(ctx.ui.notify).toHaveBeenCalledWith("✓ edit-task 수정됨: 지금부터 10분 후 제출", "info");

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(apiMock.userMessages).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(apiMock.userMessages).toEqual([{ message: "수정된 메시지", options: undefined }]);
	});

	it("keeps the latest of two concurrently edited tasks", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const listCommand = apiMock.getCommand("delay-list");
		const ctx = createCtx();
		const firstDelay = deferred<string>();
		const secondDelay = deferred<string>();
		const select = ctx.ui.select as ReturnType<typeof vi.fn>;
		select.mockImplementation(async (_title: string, options: string[]) =>
			options.length === 3 ? "수정" : options[0],
		);
		(ctx.ui.input as ReturnType<typeof vi.fn>)
			.mockImplementationOnce(() => firstDelay.promise)
			.mockImplementationOnce(() => secondDelay.promise);
		(ctx.ui.editor as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce("두 번째 수정")
			.mockResolvedValueOnce("첫 번째 수정");

		await tool.execute?.(
			"call-concurrent-edit",
			{ delay: "5m", prompt: "기존 메시지", id: "concurrent-edit" },
			undefined,
			undefined,
			ctx,
		);
		const firstEdit = listCommand.handler("", ctx);
		const secondEdit = listCommand.handler("", ctx);
		await flushMicrotasks();
		expect(ctx.ui.input).toHaveBeenCalledTimes(2);

		secondDelay.resolve("20m");
		await flushMicrotasks();
		await secondEdit;

		firstDelay.resolve("10m");
		await flushMicrotasks();
		await firstEdit;

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"예약이 변경되었거나 이미 실행/취소되었어요: concurrent-edit",
			"warning",
		);
		await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
		expect(apiMock.userMessages).toEqual([{ message: "두 번째 수정", options: undefined }]);
	});

	it("does not open the editor when a task fires while waiting for a new delay", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const listCommand = apiMock.getCommand("delay-list");
		const ctx = createCtx();
		const select = ctx.ui.select as ReturnType<typeof vi.fn>;
		select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		select.mockResolvedValueOnce("수정");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
			await vi.advanceTimersByTimeAsync(30 * 1000);
			return "5m";
		});

		await tool.execute?.(
			"call-edit-expired",
			{ delay: "30s", prompt: "원래 메시지", id: "edit-expired" },
			undefined,
			undefined,
			ctx,
		);
		await listCommand.handler("", ctx);

		expect(apiMock.userMessages).toEqual([{ message: "원래 메시지", options: undefined }]);
		expect(ctx.ui.editor).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("예약이 변경되었거나 이미 실행/취소되었어요: edit-expired", "warning");
	});

	it("keeps the original task when an edited duration is invalid", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const listCommand = apiMock.getCommand("delay-list");
		const ctx = createCtx();
		const select = ctx.ui.select as ReturnType<typeof vi.fn>;
		select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		select.mockResolvedValueOnce("수정");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("나중에");

		await tool.execute?.(
			"call-invalid-edit",
			{ delay: "5m", prompt: "원래 메시지", id: "invalid-edit" },
			undefined,
			undefined,
			ctx,
		);
		await listCommand.handler("", ctx);

		expect(ctx.ui.editor).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("지연 시간을 해석할 수 없어요. 예: 30s, 5m, 1h30m, 2시간", "warning");
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(apiMock.userMessages).toEqual([{ message: "원래 메시지", options: undefined }]);
	});

	it("does nothing when a selected task fires before the action is chosen", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const listCommand = apiMock.getCommand("delay-list");
		const ctx = createCtx();
		const select = ctx.ui.select as ReturnType<typeof vi.fn>;
		select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		select.mockImplementationOnce(async () => {
			await vi.advanceTimersByTimeAsync(30 * 1000);
			return "지금 보내기";
		});

		await tool.execute?.(
			"call-race",
			{ delay: "30s", prompt: "한 번만 보내", id: "race-task" },
			undefined,
			undefined,
			ctx,
		);
		await listCommand.handler("", ctx);

		expect(apiMock.userMessages).toEqual([{ message: "한 번만 보내", options: undefined }]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("예약이 변경되었거나 이미 실행/취소되었어요: race-task", "warning");
	});

	it("cancels a selected task without firing it", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const tool = apiMock.getTool("delay");
		const listCommand = apiMock.getCommand("delay-list");
		const ctx = createCtx();
		const select = ctx.ui.select as ReturnType<typeof vi.fn>;
		select.mockImplementationOnce(async (_title: string, options: string[]) => options[0]);
		select.mockResolvedValueOnce("예약 취소");

		await tool.execute?.(
			"call-cancel",
			{ delay: "5m", prompt: "취소할 메시지", id: "cancel-task" },
			undefined,
			undefined,
			ctx,
		);
		await listCommand.handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("✓ cancel-task 예약을 취소했어요.", "info");
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(apiMock.userMessages).toHaveLength(0);
	});
});
