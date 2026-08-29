import { describe, expect, it, vi } from "vitest";
import type { CompletedJob } from "./notification-batcher.js";
import { NotificationBatcher } from "./notification-batcher.js";

function job(id: string, tail = ["one", "two"]): CompletedJob {
	return {
		id,
		status: "succeeded",
		title: `job ${id}`,
		command: "echo ok",
		cwd: "/tmp",
		queuedAt: 0,
		startedAt: 0,
		endedAt: 1_000,
		timeoutSeconds: 10,
		log: { path: `/tmp/${id}.log`, bytes: 0, truncated: false },
		tail,
	};
}

describe("NotificationBatcher", () => {
	it("coalesces one completion per job into a follow-up message", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const batcher = new NotificationBatcher({ send });
		batcher.enqueue(job("a"));
		batcher.enqueue(job("a", ["duplicate"]));
		batcher.enqueue(job("b"));
		vi.advanceTimersByTime(500);

		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0]).toMatchObject({
			customType: "bash-async-completion",
			details: { jobIds: ["a", "b"] },
		});
		expect(send.mock.calls[0]?.[1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		vi.useRealTimers();
	});

	it("discards pending messages after shutdown", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const batcher = new NotificationBatcher({ send });
		batcher.enqueue(job("pending"));
		batcher.suppress();
		vi.advanceTimersByTime(500);
		expect(send).not.toHaveBeenCalled();
		vi.useRealTimers();
	});
});

describe("NotificationBatcher output limits", () => {
	it("limits each delivered tail to the latest 20 lines and 2KB", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const batcher = new NotificationBatcher({ send });
		batcher.enqueue(
			job(
				"large",
				Array.from({ length: 40 }, (_, index) => `${index}:${"가".repeat(400)}`),
			),
		);
		vi.advanceTimersByTime(500);

		const content = send.mock.calls[0]?.[0].content as string;
		const tail = content.slice(content.indexOf("\n") + 1, content.lastIndexOf("\nLog:"));
		expect(tail).toContain("20:");
		expect(tail).not.toContain("19:");
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(2 * 1024);
		vi.useRealTimers();
	});

	it("splits large batches so every full message stays within 8KB", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const batcher = new NotificationBatcher({ send });
		for (let index = 0; index < 10; index++) batcher.enqueue(job(`job-${index}`, ["x".repeat(2_000)]));
		vi.runAllTimers();

		expect(send.mock.calls.length).toBeGreaterThan(1);
		for (const [message] of send.mock.calls) {
			expect(Buffer.byteLength(message.content)).toBeLessThanOrEqual(8 * 1024);
		}
		const deliveredIds = send.mock.calls.flatMap(([message]) => message.details.jobIds);
		expect(deliveredIds).toEqual(Array.from({ length: 10 }, (_, index) => `job-${index}`));
		vi.useRealTimers();
	});
});
