/**
 * Auto session name — detects purpose from first user message
 * and sets it as the session name via pi.setSessionName().
 *
 * - Auto-detect: uses pi-ai completeSimple() to summarize first message → pi.setSessionName()
 * - Footer display: shows session name in status bar via setStatus()
 * - Manual control: use built-in /name command (no custom command needed)
 * - Skips auto-detection for subagent sessions
 * - Configurable model / thinking level via /auto-name:setting
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	buildNameContext,
	extractNameFromResult,
	extractSessionFilePath,
	formatNameStatus,
	isSubagentSessionPath,
	NAME_SYSTEM_PROMPT,
} from "./utils/auto-name-utils.ts";
import { formatSettings, loadSettings, setSetting, type ThinkingLevel } from "./utils/settings.ts";
import { generateShortLabel } from "./utils/short-label.js";
import { NAME_STATUS_KEY } from "./utils/status-keys.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSubagentSession(ctx: ExtensionContext): boolean {
	const sessionFilePath = extractSessionFilePath(ctx.sessionManager);
	return isSubagentSessionPath(sessionFilePath);
}

function resolveModel(ctx: ExtensionContext) {
	const settings = loadSettings();
	if (settings.modelId) {
		const parts = settings.modelId.split("/");
		if (parts.length === 2) {
			const [provider, modelId] = parts;
			const m = ctx.modelRegistry.find(provider, modelId);
			if (m) return m;
		}
	}
	return ctx.model;
}

async function detectNameFromMessage(userMessage: string, ctx: ExtensionContext): Promise<string> {
	const settings = loadSettings();
	const model = resolveModel(ctx);
	if (!model) return "";

	return generateShortLabel(
		{ model, modelRegistry: ctx.modelRegistry },
		{
			systemPrompt: NAME_SYSTEM_PROMPT,
			prompt: buildNameContext(userMessage),
			reasoning: settings.thinkingLevel ?? "minimal",
			extractText: extractNameFromResult,
		},
	);
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function autoSessionName(pi: ExtensionAPI) {
	const updateTerminalTitle = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const cwdBasename = path.basename(process.cwd());
		const name = pi.getSessionName();
		if (!name) return;
		ctx.ui.setTitle(`π - ${name} - ${cwdBasename}`);
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const name = pi.getSessionName();
		if (!name) {
			ctx.ui.setStatus(NAME_STATUS_KEY, undefined);
			return;
		}

		ctx.ui.setStatus(NAME_STATUS_KEY, formatNameStatus(name));
		updateTerminalTitle(ctx);
	};

	// ── Auto Name (async) ──────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (isSubagentSession(ctx)) return;

		// name이 이미 있으면 스킵
		if (pi.getSessionName()) return;

		const text = event.prompt.trim();
		if (!text) return;

		// Fire-and-forget: 비동기로 name 감지 후 설정
		(async () => {
			try {
				const detected = await detectNameFromMessage(text, ctx);
				if (detected && !pi.getSessionName()) {
					pi.setSessionName(detected);
					updateStatus(ctx);
				}
			} catch {
				// 실패 시 무시
			}
		})();
	});

	// ── Command: /auto-name:setting ─────────────────────────────

	pi.registerCommand("auto-name:setting", {
		description: "Configure auto-name model and thinking level. Usage: /auto-name:setting [model|thinking] [value]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const tokens = args.trim().split(/\s+/);
			const subCommand = tokens[0];

			// 값 없이 입력하면 현재 설정 표시
			if (!subCommand) {
				const settings = loadSettings();
				ctx.ui.notify(formatSettings(settings), "info");
				return;
			}

			if (subCommand === "model") {
				const modelId = tokens.slice(1).join(" ").trim();
				if (!modelId) {
					ctx.ui.notify(
						"사용법: /auto-name:setting model <provider/model-id> (예: anthropic/claude-sonnet-4-20250514)",
						"warning",
					);
					return;
				}
				const parts = modelId.split("/");
				if (parts.length !== 2) {
					ctx.ui.notify('모델 ID는 "provider/model-id" 형식이어야 합니다. (예: openai/gpt-4o)', "warning");
					return;
				}
				const [provider, id] = parts;
				const m = ctx.modelRegistry.find(provider, id);
				if (!m) {
					ctx.ui.notify(`모델을 찾을 수 없습니다: ${modelId}`, "error");
					return;
				}
				setSetting("modelId", modelId);
				ctx.ui.notify(`auto-name 모델이 설정되었습니다: ${m.name} (${modelId})`, "info");
				return;
			}

			if (subCommand === "thinking") {
				const level = tokens[1]?.trim() as ThinkingLevel | undefined;
				const validLevels: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
				if (!level || !validLevels.includes(level)) {
					ctx.ui.notify(`사용법: /auto-name:setting thinking <${validLevels.join("|")}>`, "warning");
					return;
				}
				setSetting("thinkingLevel", level);
				ctx.ui.notify(`auto-name 추론 레벨이 설정되었습니다: ${level}`, "info");
				return;
			}

			ctx.ui.notify(`알 수 없는 설정: ${subCommand}. 사용 가능: model, thinking`, "warning");
		},
	});

	// ── Lifecycle ─────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(NAME_STATUS_KEY, undefined);
	});
}
