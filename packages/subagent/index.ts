/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports a single run mode via the CLI-style `subagent` command.
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Architecture:
 *   types.ts     — Type definitions, interfaces, Typebox schemas
 *   store.ts     — Shared state (SubagentStore) and state-mutation helpers
 *   format.ts    — Token/usage/tool-call formatting utilities
 *   session.ts   — Session file management and context helpers
 *   runner.ts    — Subagent process execution, agent matching, concurrency
 *   replay.ts    — Session replay viewer (TUI overlay)
 *   widget.ts    — Run status widget (above-editor display)
 *   commands.ts  — Tool handler, slash-commands, event handlers
 *   lifecycle.ts — Hang detection sweeps and shutdown cleanup
 *   index.ts     — Thin boot orchestrator (this file)
 *
 * Boot strategy: this entrypoint imports only constants and registers thin
 * event wrappers, then loads the heavy module graph lazily in the background.
 * before_agent_start awaits the lazy core so tools (subagent, list-agents,
 * ask_master) are always registered before the first agent turn — including
 * headless (`pi -p`) runs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HANG_CHECK_INTERVAL_MS } from "./constants.js";
import { SUBAGENT_COMMANDS, SUBAGENT_SHORTCUTS, type SubagentCommandName } from "./registration-manifest.js";

interface SubagentCore {
	store: import("./store.js").SubagentStore;
	commands: typeof import("./commands.js");
	registrations: import("./commands.js").SubagentRegistrations;
	escalation: typeof import("./escalation.js");
	lifecycle: typeof import("./lifecycle.js");
}

export default function (pi: ExtensionAPI) {
	let core: SubagentCore | null = null;
	let corePromise: Promise<SubagentCore> | null = null;
	/** Serializes session lifecycle work so events apply in dispatch order. */
	let chain: Promise<void> = Promise.resolve();

	const loadCore = (): Promise<SubagentCore> => {
		corePromise ??= (async () => {
			const [commands, escalation, lifecycle, storeMod] = await Promise.all([
				import("./commands.js"),
				import("./escalation.js"),
				import("./lifecycle.js"),
				import("./store.js"),
			]);
			const store = storeMod.createStore();
			const registrations = commands.registerAll(pi, store);
			core = { store, commands, registrations, escalation, lifecycle };
			return core;
		})().catch((error) => {
			corePromise = null;
			throw error;
		});
		return corePromise;
	};

	const enqueue = (fn: (core: SubagentCore) => void): Promise<void> => {
		chain = chain
			.then(() => loadCore())
			.then(fn)
			.catch((err) => {
				process.stderr.write(`[subagent] deferred init failed: ${err instanceof Error ? err.message : err}\n`);
			});
		return chain;
	};

	const getCommandDefinition = async (name: SubagentCommandName) => {
		const loaded = await loadCore();
		await chain;
		const definition = loaded.registrations.commands.get(name);
		if (!definition) throw new Error(`Subagent command definition not found: ${name}`);
		return definition;
	};

	// Register lightweight proxies synchronously so Pi's initial autocomplete
	// and command registry contain every subagent command before lazy core load.
	for (const [name, description] of Object.entries(SUBAGENT_COMMANDS) as Array<[SubagentCommandName, string]>) {
		pi.registerCommand(name, {
			description,
			getArgumentCompletions: async (prefix) => {
				const definition = await getCommandDefinition(name);
				return definition.getArgumentCompletions?.(prefix) ?? null;
			},
			handler: async (args, ctx) => {
				const definition = await getCommandDefinition(name);
				return definition.handler(args, ctx);
			},
		});
	}

	// These entries document text-prefix shortcuts in /hotkeys. Actual routing
	// remains in commands.ts input handlers after the lazy core is loaded.
	for (const [shortcut, description] of Object.entries(SUBAGENT_SHORTCUTS)) {
		pi.registerShortcut(shortcut as never, {
			description,
			handler: async () => {},
		});
	}

	// Start loading in the background without blocking extension boot.
	// setTimeout keeps the load out of the boot path's microtask drains.
	setTimeout(() => {
		void loadCore().catch(() => {
			// Reported when the first enqueue/await surfaces the failure.
		});
	}, 0);

	let hangCheckTimer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", (_event, ctx) => {
		enqueue((c) => {
			c.store.disposed = false;
			c.commands.handleSessionStart(pi, c.store, ctx as unknown as ExtensionContext);
			c.escalation.maybeRegisterAskMaster(pi, ctx);
		});
		if (!hangCheckTimer) {
			hangCheckTimer = setInterval(() => {
				if (core) core.lifecycle.checkForHungRuns(core.store, pi);
			}, HANG_CHECK_INTERVAL_MS);
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (hangCheckTimer) {
			clearInterval(hangCheckTimer);
			hangCheckTimer = undefined;
		}
		// Wait for any queued session_start work so its loadCore() is visible here.
		await chain;
		if (!corePromise) return;
		const c = await loadCore();
		c.lifecycle.shutdownSubagentRuns(c.store, pi, event.reason);
		c.commands.handleSessionShutdown();
		c.lifecycle.cleanupPixelTimer();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const c = await loadCore();
		await chain;
		return c.commands.handleBeforeAgentStart(event, ctx, c.store);
	});

	// If input arrives while the core is still loading, awaiting here lets the
	// live handler-array dispatch reach the shortcut handlers registerAll adds.
	pi.on("input", async () => {
		if (!core) await loadCore().catch(() => {});
		return { action: "continue" as const };
	});
}
