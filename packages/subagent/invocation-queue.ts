import { SUBAGENT_QUEUE_INTERVAL_MS } from "./constants.js";

let startQueueTail: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Queue only subagent invocation starts through a single pacing queue.
 *
 * Each invocation waits for its start slot (fixed delay per slot), but once
 * started the job runs independently so multiple subagents can execute in
 * parallel.
 */
export function enqueueSubagentInvocation<T>(job: () => Promise<T>): Promise<T> {
	const startGate = startQueueTail.then(
		() => sleep(SUBAGENT_QUEUE_INTERVAL_MS),
		() => sleep(SUBAGENT_QUEUE_INTERVAL_MS),
	);

	// Important: only pace the next start slot. Do not wait for job completion.
	startQueueTail = startGate.then(
		() => undefined,
		() => undefined,
	);

	return startGate.then(() => job());
}
