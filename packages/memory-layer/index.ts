/**
 * Memory Layer — thin boot entrypoint.
 *
 * Loads the full implementation (main.ts) lazily in the background so pi boot
 * stays fast. before_agent_start awaits the lazy load, guaranteeing memory
 * injection and tool registration before the first agent turn — including
 * headless (`pi -p`) runs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryLayerHandlers } from "./main.ts";

export default function memoryLayerExtension(pi: ExtensionAPI) {
	let handlersPromise: Promise<MemoryLayerHandlers> | null = null;
	/** Serializes lifecycle work so session_start effects land before agent turns. */
	let chain: Promise<void> = Promise.resolve();

	const load = (): Promise<MemoryLayerHandlers> => {
		handlersPromise ??= import("./main.ts").then((m) => m.registerMemoryLayer(pi));
		return handlersPromise;
	};

	// Start loading in the background without blocking extension boot.
	// setTimeout keeps the load out of the boot path's microtask drains.
	setTimeout(() => {
		void load().catch(() => {
			// Surfaced when a wrapper below awaits the failed load.
		});
	}, 0);

	pi.on("session_start", (event, ctx) => {
		chain = chain
			.then(() => load())
			.then((h) => h.onSessionStart(event, ctx as unknown as ExtensionContext))
			.catch((err) => {
				process.stderr.write(`[memory-layer] deferred init failed: ${err instanceof Error ? err.message : err}\n`);
			});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const handlers = await load();
		await chain;
		return handlers.onBeforeAgentStart(event, ctx as unknown as ExtensionContext);
	});
}
