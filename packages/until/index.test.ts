import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionApiMock, type ExtensionApiMock } from "../../tests/mock-extension-api.ts";
import untilExtension, { createUntilExtension, formatClock, formatKoreanDuration, parseInterval } from "./index.ts";

type ContextHarness = {
	ctx: ExtensionContext;
	isIdle: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
};

type SentMessage = {
	customType?: string;
	content?: unknown;
	details?: { taskId?: number; runCount?: number };
};

type SendMessageArgs = Parameters<ExtensionAPI["sendMessage"]>;

const tempDirs: string[] = [];

function createContext(options: { hasUI?: boolean; isIdle?: boolean; themeFg?: boolean } = {}): ContextHarness {
	const notify = vi.fn();
	const setStatus = vi.fn();
	const isIdle = vi.fn(() => options.isIdle ?? true);
	const theme =
		options.themeFg === false
			? { bg: (_color: string, text: string) => text }
			: {
					fg: (_color: string, text: string) => text,
					bg: (_color: string, text: string) => text,
				};
	return {
		ctx: {
			hasUI: options.hasUI ?? true,
			isIdle,
			ui: { notify, setStatus, theme },
		} as unknown as ExtensionContext,
		isIdle,
		notify,
		setStatus,
	};
}

function getUntilPrompts(apiMock: ExtensionApiMock): SentMessage[] {
	return apiMock.sentMessages
		.map((message) => message as SentMessage)
		.filter((message) => message.customType === "until-prompt");
}

function overrideSendMessage(apiMock: ExtensionApiMock, beforeSend: (message: SentMessage) => void): void {
	const originalSendMessage = apiMock.api.sendMessage.bind(apiMock.api);
	(apiMock.api as unknown as { sendMessage: ExtensionAPI["sendMessage"] }).sendMessage = ((
		...args: SendMessageArgs
	) => {
		beforeSend(args[0] as SentMessage);
		return originalSendMessage(...args);
	}) as ExtensionAPI["sendMessage"];
}

function getToolExecute(apiMock: ExtensionApiMock) {
	const execute = apiMock.getTool("until_report").execute;
	if (!execute) throw new Error("until_report execute is missing");
	return execute;
}

async function report(
	apiMock: ExtensionApiMock,
	ctx: ExtensionContext,
	params: { taskId: number; runCount: number; done: boolean; summary: string },
) {
	return getToolExecute(apiMock)("call", params, undefined, undefined, ctx);
}

async function registerAndDispatch(apiMock: ExtensionApiMock, ctx: ExtensionContext, command = "1분 배포 상태 확인") {
	await apiMock.getCommand("until").handler(command, ctx);
	await vi.advanceTimersByTimeAsync(0);
}

describe("until extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
	});

	it("parses supported interval formats", () => {
		expect(parseInterval("5m")).toEqual({ ms: 5 * 60_000, label: "5분" });
		expect(parseInterval("1시간마다")).toEqual({ ms: 60 * 60_000, label: "1시간" });
		expect(parseInterval("2분")).toEqual({ ms: 2 * 60_000, label: "2분" });
		expect(parseInterval("0분")).toBeNull();
		expect(parseInterval("soon")).toBeNull();
		expect(parseInterval("5s")).toBeNull();
		expect(parseInterval("NaNm")).toBeNull();
		expect(formatKoreanDuration(3_660_000)).toBe("1시간 1분");
		expect(formatClock(0)).toEqual(expect.any(String));
	});

	it("registers, repeats, and completes until tasks", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const { ctx, notify } = createContext();

		await registerAndDispatch(apiMock, ctx);
		expect(apiMock.sentMessages[0]).toMatchObject({
			customType: "until",
			content: expect.stringContaining("[until #1] 등록됨: 1분마다 반복"),
		});
		expect(apiMock.sentMessages[1]).toMatchObject({
			customType: "until-prompt",
			content: expect.stringContaining("- runCount: 1"),
			details: expect.objectContaining({ taskId: 1, runCount: 1, displayPrompt: "배포 상태 확인" }),
		});

		const keepGoing = await report(apiMock, ctx, { taskId: 1, runCount: 1, done: false, summary: "아직 배포 중" });
		expect(keepGoing).toMatchObject({ details: { done: false, summary: "아직 배포 중", taskId: 1, runCount: 1 } });
		await apiMock.getCommand("untils").handler("", ctx);
		expect(apiMock.sentMessages[2]).toMatchObject({ content: expect.stringContaining("최근: 아직 배포 중") });

		await vi.advanceTimersByTimeAsync(60_000);
		expect(apiMock.sentMessages[3]).toMatchObject({ customType: "until-prompt", details: { runCount: 2 } });
		const done = await report(apiMock, ctx, { taskId: 1, runCount: 2, done: true, summary: "배포 완료" });
		expect(done).toMatchObject({
			details: { done: true, summary: "배포 완료", taskId: 1, runCount: 2 },
			terminate: true,
		});
		await apiMock.getCommand("untils").handler("", ctx);
		expect(notify).toHaveBeenCalledWith("활성 until 작업이 없어.", "info");
	});

	it("rejects stale or mismatched run reports without changing the task", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const { ctx } = createContext();
		await registerAndDispatch(apiMock, ctx);

		await expect(report(apiMock, ctx, { taskId: 1, runCount: 0, done: true, summary: "stale" })).rejects.toThrow(
			"현재 회차가 아닙니다",
		);
		await apiMock.getCommand("untils").handler("", ctx);
		expect(apiMock.sentMessages.at(-1)).toMatchObject({
			content: expect.not.stringContaining("stale"),
		});
		await expect(report(apiMock, ctx, { taskId: 1, runCount: 2, done: false, summary: "future" })).rejects.toThrow(
			"현재 회차가 아닙니다",
		);
	});

	it("does not recover on agent_end or non-idle agent_settled", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const harness = createContext({ isIdle: false });
		await registerAndDispatch(apiMock, harness.ctx);

		await apiMock.getHandlers("agent_end")[0]({}, harness.ctx);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(getUntilPrompts(apiMock)).toHaveLength(1);
		await apiMock.getHandlers("agent_settled")[0]({}, harness.ctx);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(getUntilPrompts(apiMock)).toHaveLength(1);
	});

	it("releases an unreported generation after idle agent_settled and reruns on its timer", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const harness = createContext({ isIdle: true });
		await registerAndDispatch(apiMock, harness.ctx);

		await apiMock.getHandlers("agent_settled")[0]({}, harness.ctx);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(apiMock.sentMessages.at(-1)).toMatchObject({
			customType: "until-prompt",
			details: { taskId: 1, runCount: 2 },
		});
	});

	it("uses the idle timer fallback when agent_settled is missing", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const harness = createContext({ isIdle: true });
		await registerAndDispatch(apiMock, harness.ctx);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(apiMock.sentMessages.at(-1)).toMatchObject({
			customType: "until-prompt",
			details: { taskId: 1, runCount: 2 },
		});
	});

	it("keeps concurrent task generations independent", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const harness = createContext({ isIdle: true });
		await apiMock.getCommand("until").handler("1분 첫 번째", harness.ctx);
		await apiMock.getCommand("until").handler("1분 두 번째", harness.ctx);
		await vi.advanceTimersByTimeAsync(0);

		await report(apiMock, harness.ctx, { taskId: 1, runCount: 1, done: false, summary: "one reported" });
		await apiMock.getHandlers("agent_settled")[0]({}, harness.ctx);
		await expect(report(apiMock, harness.ctx, { taskId: 2, runCount: 1, done: true, summary: "late" })).rejects.toThrow(
			"활성 회차가 없습니다",
		);
		await vi.advanceTimersByTimeAsync(60_000);
		const prompts = getUntilPrompts(apiMock);
		expect(prompts.filter((message) => message.details?.taskId === 1).at(-1)?.details?.runCount).toBe(2);
		expect(prompts.filter((message) => message.details?.taskId === 2).at(-1)?.details?.runCount).toBe(2);
	});

	it("recovers from synchronous prompt dispatch failure", async () => {
		const apiMock = createExtensionApiMock();
		let shouldThrow = true;
		overrideSendMessage(apiMock, (message) => {
			if (message.customType === "until-prompt" && shouldThrow) {
				shouldThrow = false;
				throw new Error("dispatch failed");
			}
		});
		untilExtension(apiMock.api);
		const harness = createContext({ isIdle: false });

		await registerAndDispatch(apiMock, harness.ctx);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(apiMock.sentMessages.at(-1)).toMatchObject({
			customType: "until-prompt",
			details: { taskId: 1, runCount: 2 },
		});
	});

	it("contains UI failures and supports headless contexts", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const noTheme = createContext({ themeFg: false });
		noTheme.setStatus.mockImplementationOnce(() => {
			throw new Error("status failed");
		});
		await registerAndDispatch(apiMock, noTheme.ctx);
		expect(apiMock.sentMessages.at(-1)).toMatchObject({ customType: "until-prompt" });

		const headlessMock = createExtensionApiMock();
		untilExtension(headlessMock.api);
		const headless = createContext({ hasUI: false });
		await registerAndDispatch(headlessMock, headless.ctx);
		expect(headless.notify).not.toHaveBeenCalled();
		expect(headless.setStatus).not.toHaveBeenCalled();
	});

	it("keeps scheduling when recurring notify throws", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const harness = createContext();
		await registerAndDispatch(apiMock, harness.ctx);
		await report(apiMock, harness.ctx, { taskId: 1, runCount: 1, done: false, summary: "continue" });
		harness.notify.mockImplementation(() => {
			throw new Error("notify failed");
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(apiMock.sentMessages.at(-1)).toMatchObject({ customType: "until-prompt", details: { runCount: 2 } });
	});

	it("removes expired tasks even when the expiry message throws", async () => {
		const apiMock = createExtensionApiMock();
		overrideSendMessage(apiMock, (message) => {
			if (message.customType === "until" && String(message.content).includes("24시간 만료"))
				throw new Error("message failed");
		});
		untilExtension(apiMock.api);
		const harness = createContext({ isIdle: false });
		await registerAndDispatch(apiMock, harness.ctx, "1시간 오래 확인");
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
		await apiMock.getCommand("untils").handler("", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith("활성 until 작업이 없어.", "info");
	});

	it("returns a terminating result and removes the task when completion UI fails", async () => {
		const apiMock = createExtensionApiMock();
		overrideSendMessage(apiMock, (message) => {
			if (message.customType === "until" && String(message.content).includes("조건 충족"))
				throw new Error("message failed");
		});
		untilExtension(apiMock.api);
		const harness = createContext();
		await registerAndDispatch(apiMock, harness.ctx);
		harness.notify.mockImplementation(() => {
			throw new Error("notify failed");
		});
		const result = await report(apiMock, harness.ctx, { taskId: 1, runCount: 1, done: true, summary: "done" });
		expect(result).toMatchObject({ terminate: true, details: { done: true } });
		await apiMock.getCommand("untils").handler("", harness.ctx);
		expect(getUntilPrompts(apiMock)).toHaveLength(1);
	});

	it("enforces task and interval limits", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const harness = createContext();
		await apiMock.getCommand("until").handler("0.5m too fast", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("최소 간격은 1분"), "error");
		for (const prompt of ["1분 one", "1분 two", "1분 three", "1분 four"]) {
			await apiMock.getCommand("until").handler(prompt, harness.ctx);
		}
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("최대 3개"), "error");
	});

	it("cancels all pending tasks and keeps no-arg cancellation non-destructive", async () => {
		const apiMock = createExtensionApiMock();
		untilExtension(apiMock.api);
		const harness = createContext();
		await apiMock.getCommand("until").handler("1분 첫 번째 확인", harness.ctx);
		await apiMock.getCommand("until").handler("2분 두 번째 확인", harness.ctx);
		const cancel = apiMock.getCommand("until-cancel");
		expect(cancel.getArgumentCompletions?.("")).toEqual([
			{ label: "all", value: "all" },
			{ label: "1", value: "1" },
			{ label: "2", value: "2" },
		]);
		await cancel.handler("", harness.ctx);
		await apiMock.getCommand("untils").handler("", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith("사용법: /until-cancel <id|all>", "info");
		expect(apiMock.sentMessages.at(-1)).toMatchObject({ content: expect.stringContaining("활성 until 목록 (2개)") });
		await cancel.handler("all", harness.ctx);
		await apiMock.getCommand("untils").handler("", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith("until 2개 취소됨", "info");
		expect(harness.notify).toHaveBeenCalledWith("활성 until 작업이 없어.", "info");
	});

	it("loads direct and interval-override presets and reports malformed files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "until-command-presets-"));
		tempDirs.push(dir);
		await writeFile(join(dir, "review.md"), "---\ninterval: 15m\ndescription: Review queue\n---\nCheck reviews.");
		await writeFile(join(dir, "broken.md"), "---\ninterval: soon\n---\nBroken.");
		const apiMock = createExtensionApiMock();
		createUntilExtension({ presetsDir: dir })(apiMock.api);
		const harness = createContext();

		const command = apiMock.getCommand("until");
		expect(command.getArgumentCompletions?.("RE")).toEqual([
			{ label: "REVIEW - Review queue (15분)", value: "REVIEW" },
		]);
		await command.handler("REVIEW", harness.ctx);
		expect(apiMock.sentMessages.at(-1)).toMatchObject({
			content: expect.stringContaining("등록됨: 15분마다"),
			details: expect.objectContaining({ prompt: "Check reviews.", displayPrompt: "[preset REVIEW] Review queue" }),
		});
		await command.handler("10m REVIEW", harness.ctx);
		expect(apiMock.sentMessages.at(-1)).toMatchObject({ content: expect.stringContaining("등록됨: 10분마다") });
		await command.handler("BROKEN", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('프리셋 "BROKEN" 파일은 있지만'), "error");
	});

	it("works with a missing preset directory and clears all session state", async () => {
		const dir = join(tmpdir(), `until-missing-${Date.now()}`);
		const apiMock = createExtensionApiMock();
		createUntilExtension({ presetsDir: dir })(apiMock.api);
		const harness = createContext();
		await apiMock.getCommand("until").handler("1분 일반 작업", harness.ctx);
		await apiMock.getHandlers("agent_start")[0]({}, harness.ctx);
		await apiMock.getHandlers("session_start")[0]({}, harness.ctx);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(getUntilPrompts(apiMock)).toHaveLength(0);
		expect(harness.setStatus).toHaveBeenCalledWith("until-footer", undefined);

		await apiMock.getCommand("until").handler("1분 다시", harness.ctx);
		await apiMock.getHandlers("session_shutdown")[0]({}, harness.ctx);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(getUntilPrompts(apiMock)).toHaveLength(0);
	});
});
