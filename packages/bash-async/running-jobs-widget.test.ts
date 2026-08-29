/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight TUI and theme fixtures. */
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createRunningJobsWidget, formatElapsed, sanitizeTitle } from "./running-jobs-widget.js";
import type { BashAsyncJob } from "./types.js";

function runningJob(overrides: Partial<BashAsyncJob> = {}): BashAsyncJob {
	return {
		id: "job-1",
		status: "running",
		title: "Build extensions",
		command: "pnpm test",
		cwd: "/tmp",
		queuedAt: 0,
		startedAt: 0,
		timeoutSeconds: 60,
		log: { path: "/tmp/job.log", bytes: 0, truncated: false },
		...overrides,
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
};

function createTui() {
	return { requestRender: vi.fn() };
}

describe("running bash_async jobs widget", () => {
	it("renders every running job in start order with elapsed time", () => {
		const tui = createTui();
		const jobs = [
			runningJob({ id: "queued", status: "queued", title: "Queued", startedAt: undefined }),
			runningJob({ id: "second", title: "Second", startedAt: 2_000 }),
			runningJob({ id: "first", title: "First", startedAt: 1_000 }),
		];
		const widget = createRunningJobsWidget(tui as any, theme as any, {
			getRunningJobs: () => jobs,
			now: () => 6_000,
		});

		expect(widget.render(80)).toEqual(["bash_async · First · 5s", "bash_async · Second · 4s"]);
		widget.dispose();
	});

	it("formats elapsed time across minutes and hours", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(61_000)).toBe("1m 1s");
		expect(formatElapsed(3_661_000)).toBe("1h 1m");
	});

	it("sanitizes titles and truncates each rendered line to its viewport width", () => {
		const tui = createTui();
		const widget = createRunningJobsWidget(tui as any, theme as any, {
			getRunningJobs: () => [runningJob({ title: "  build\n\u001B[31munsafe\u001B[0m\toutput  " })],
			now: () => 10_000,
		});

		expect(sanitizeTitle("  build\n\u001B[31munsafe\u001B[0m\toutput  ")).toBe("build unsafe output");
		const [line] = widget.render(24);
		expect(stripTerminalSequences(line ?? "")).toBe("bash_async · bu... · 10s");
		expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(24);
		widget.dispose();
	});

	it("requests rendering every second and disposes its timer idempotently", () => {
		vi.useFakeTimers();
		const tui = createTui();
		const widget = createRunningJobsWidget(tui as any, theme as any, {
			getRunningJobs: () => [runningJob()],
			now: () => 0,
		});

		vi.advanceTimersByTime(1_000);
		expect(tui.requestRender).toHaveBeenCalledOnce();
		widget.dispose();
		widget.dispose();
		vi.advanceTimersByTime(2_000);
		expect(tui.requestRender).toHaveBeenCalledOnce();
		vi.useRealTimers();
	});
});
