import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_FILE = join(homedir(), ".pi", "agent", "state", "codex-large-context.json");
export const TARGET_CONTEXT_WINDOW = 922_000;
export const TARGET_MODEL_PREFIXES = ["gpt-5.4", "gpt-5.5"] as const;
const TARGET_MODEL_LABEL = TARGET_MODEL_PREFIXES.join(" or ");

type LargeContextState = {
	enabled: boolean;
};

export function loadCodexLargeContextState(): LargeContextState {
	try {
		const raw = readFileSync(STATE_FILE, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed?.enabled === "boolean") {
			return { enabled: parsed.enabled };
		}
	} catch {
		// Ignore missing/corrupt state and fall back to the default-enabled behavior.
	}

	return { enabled: true };
}

export function isCodexLargeContextEnabled(): boolean {
	return loadCodexLargeContextState().enabled;
}

function saveState(state: LargeContextState): void {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parseCommandArg(args: string): "on" | "off" | "status" | "help" {
	const arg = args.trim().toLowerCase();
	if (arg === "on" || arg === "off" || arg === "status") return arg;
	return arg ? "help" : "status";
}

export function isTargetModelId(modelId: string | undefined): boolean {
	if (!modelId) return false;
	return TARGET_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

export async function applyLargeContext(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	if (!isCodexLargeContextEnabled()) return false;

	const model = ctx.model;
	if (!model) return false;
	if (!isTargetModelId(model.id)) return false;
	if (model.contextWindow >= TARGET_CONTEXT_WINDOW) return false;

	const previousContextWindow = model.contextWindow;
	const updated = { ...model, contextWindow: TARGET_CONTEXT_WINDOW };
	const ok = await pi.setModel(updated);

	if (ok && ctx.hasUI) {
		ctx.ui.notify(
			`${model.id} context window: ${(previousContextWindow / 1000).toFixed(0)}K → ${(TARGET_CONTEXT_WINDOW / 1000).toFixed(0)}K`,
			"info",
		);
	}

	return ok;
}

export default function codexLargeContext(pi: ExtensionAPI) {
	pi.on("model_select", async (_event, ctx) => {
		await applyLargeContext(pi, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		await applyLargeContext(pi, ctx);
	});

	pi.registerCommand("codex-large-context", {
		description: "Toggle Codex Large Context for openai-codex/gpt-5.4 or gpt-5.5",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status"];
			const filtered = options.filter((option) => option.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (args, ctx) => {
			const action = parseCommandArg(args);

			if (action === "help") {
				if (ctx.hasUI) {
					ctx.ui.notify("Usage: /codex-large-context [on|off|status]", "info");
				}
				return;
			}

			if (action === "status") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Codex Large Context: ${isCodexLargeContextEnabled() ? "ON" : "OFF"} (${TARGET_MODEL_LABEL} → ${(TARGET_CONTEXT_WINDOW / 1000).toFixed(0)}K)`,
						"info",
					);
				}
				return;
			}

			const nextState = { enabled: action === "on" };
			saveState(nextState);

			if (ctx.hasUI) {
				ctx.ui.notify(
					nextState.enabled
						? `Codex Large Context enabled (${TARGET_MODEL_LABEL} → ${(TARGET_CONTEXT_WINDOW / 1000).toFixed(0)}K)`
						: "Codex Large Context disabled",
					"info",
				);
			}

			if (nextState.enabled) {
				await applyLargeContext(pi, ctx);
			}
		},
	});
}
