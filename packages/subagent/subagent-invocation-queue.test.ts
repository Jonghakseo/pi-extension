import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function loadQueueModule() {
	vi.resetModules();
	return await import("./invocation-queue.js");
}

describe("enqueueSubagentInvocation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("paces starts at 1s intervals while allowing overlapping executions", async () => {
		const { enqueueSubagentInvocation } = await loadQueueModule();
		const starts: number[] = [];

		const deferred1 = createDeferred<string>();
		const deferred2 = createDeferred<string>();
		const deferred3 = createDeferred<string>();

		const run1 = enqueueSubagentInvocation(async () => {
			starts.push(Date.now());
			return deferred1.promise;
		});
		const run2 = enqueueSubagentInvocation(async () => {
			starts.push(Date.now());
			return deferred2.promise;
		});
		const run3 = enqueueSubagentInvocation(async () => {
			starts.push(Date.now());
			return deferred3.promise;
		});

		expect(starts).toEqual([]);

		await vi.advanceTimersByTimeAsync(1000);
		expect(starts).toEqual([1000]);

		await vi.advanceTimersByTimeAsync(1000);
		expect(starts).toEqual([1000, 2000]);

		await vi.advanceTimersByTimeAsync(1000);
		expect(starts).toEqual([1000, 2000, 3000]);

		deferred1.resolve("one");
		deferred2.resolve("two");
		deferred3.resolve("three");

		await expect(run1).resolves.toBe("one");
		await expect(run2).resolves.toBe("two");
		await expect(run3).resolves.toBe("three");
	});

	it("lets later runs finish before earlier runs complete", async () => {
		const { enqueueSubagentInvocation } = await loadQueueModule();

		const deferred1 = createDeferred<string>();
		const deferred2 = createDeferred<string>();
		let run1Settled = false;

		const run1 = enqueueSubagentInvocation(async () => deferred1.promise).finally(() => {
			run1Settled = true;
		});
		const run2 = enqueueSubagentInvocation(async () => deferred2.promise);

		await vi.advanceTimersByTimeAsync(2000);

		deferred2.resolve("second-done");
		await expect(run2).resolves.toBe("second-done");
		expect(run1Settled).toBe(false);

		deferred1.resolve("first-done");
		await expect(run1).resolves.toBe("first-done");
	});
});
