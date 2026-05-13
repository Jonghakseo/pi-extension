import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import delayedActionExtension from "./index.ts";

describe("delayed-action extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("warns when only a delay is provided", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const inputHandler = apiMock.getHandlers("input")[0];
		if (!inputHandler) throw new Error("input handler missing");

		const notify = vi.fn();
		const result = await inputHandler({ source: "user", text: "10분 있다가" }, {
			hasUI: true,
			ui: { notify },
		} as unknown as ExtensionContext);

		expect(result).toEqual({ action: "handled" });
		expect(notify).toHaveBeenCalledWith('예약할 작업도 같이 써줘. 예: "10분 있다가 배포 로그 확인해"', "warning");
	});

	it("schedules and fires reminders from user input", async () => {
		const apiMock = createExtensionApiMock();
		delayedActionExtension(apiMock.api);
		const inputHandler = apiMock.getHandlers("input")[0];
		if (!inputHandler) throw new Error("input handler missing");

		const notify = vi.fn();
		const ctx = {
			hasUI: true,
			ui: { notify },
		} as unknown as ExtensionContext;

		const result = await inputHandler({ source: "user", text: "10분 있다가 배포 로그 확인해" }, ctx);

		expect(result).toEqual({ action: "handled" });
		expect(apiMock.sentMessages).toHaveLength(1);
		expect(apiMock.userMessages).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

		expect(apiMock.sentMessages).toHaveLength(2);
		expect(apiMock.userMessages).toEqual([
			{
				message: "예약한 시간이 되었어. 지금 아래 작업을 수행해줘.\n\n배포 로그 확인해",
				options: undefined,
			},
		]);
		expect(notify).toHaveBeenCalledWith("⏰ reminder #1 설정됨 (10분)", "info");
		expect(notify).toHaveBeenCalledWith("⏰ reminder #1 실행됨", "info");
	});
});
