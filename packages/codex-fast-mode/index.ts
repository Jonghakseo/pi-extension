import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { streamSimpleOpenAICodexResponses } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATE_FILE = join(homedir(), ".pi", "agent", "state", "codex-fast-mode.json");
export const SUPPORTED_MODEL_ID = "gpt-5.4";

type FastModeState = {
	enabled: boolean;
};

export function loadCodexFastModeState(): FastModeState {
	try {
		const raw = readFileSync(STATE_FILE, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed?.enabled === "boolean") {
			return { enabled: parsed.enabled };
		}
	} catch {
		// Ignore missing/corrupt state and fall back to default.
	}

	return { enabled: false };
}

export function isCodexFastModeEnabled(): boolean {
	return loadCodexFastModeState().enabled;
}

export function shouldUseCodexFastBadge(provider: string | undefined, modelId: string | undefined): boolean {
	return provider === "openai-codex" && modelId === SUPPORTED_MODEL_ID && isCodexFastModeEnabled();
}

function saveState(state: FastModeState): void {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFastSupportedModel(modelId: string): boolean {
	return modelId === SUPPORTED_MODEL_ID;
}

function parseCommandArg(args: string): "on" | "off" | "status" | "help" {
	const arg = args.trim().toLowerCase();
	if (arg === "on" || arg === "off" || arg === "status") return arg;
	return arg ? "help" : "status";
}

export default function codexFastMode(pi: ExtensionAPI) {
	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple(model, context, options) {
			return streamSimpleOpenAICodexResponses(model as never, context, {
				...options,
				onPayload: async (payload, innerModel) => {
					const upstreamPayload =
						typeof options?.onPayload === "function"
							? ((await options.onPayload(payload, innerModel)) ?? payload)
							: payload;

					if (!isRecord(upstreamPayload)) return upstreamPayload;
					if (innerModel.provider !== "openai-codex") return upstreamPayload;
					if (!isFastSupportedModel(innerModel.id)) return upstreamPayload;

					const nextPayload = {
						...upstreamPayload,
						text: {
							...(isRecord(upstreamPayload.text) ? upstreamPayload.text : {}),
							verbosity: "low",
						},
					};

					if (!isCodexFastModeEnabled()) return nextPayload;

					return {
						...nextPayload,
						service_tier: "priority",
					};
				},
			});
		},
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle Codex Fast Mode service tier injection for openai-codex/gpt-5.4",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status"];
			const filtered = options.filter((o) => o.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			const action = parseCommandArg(args);

			if (action === "help") {
				if (ctx.hasUI) {
					ctx.ui.notify("Usage: /codex-fast [on|off|status]", "info");
				}
				return;
			}

			if (action === "status") {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Codex Fast Mode: ${isCodexFastModeEnabled() ? "ON" : "OFF"} (always force text.verbosity=low; inject service_tier=priority when ON for openai-codex/${SUPPORTED_MODEL_ID})`,
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
						? `Codex Fast Mode enabled (openai-codex/${SUPPORTED_MODEL_ID} → text.verbosity=low + service_tier=priority)`
						: `Codex Fast Mode disabled (text.verbosity=low still applies for openai-codex/${SUPPORTED_MODEL_ID})`,
					"info",
				);
			}
		},
	});
}
