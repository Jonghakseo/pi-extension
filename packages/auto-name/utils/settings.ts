import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export const SETTINGS_DIR = path.join(os.homedir(), ".pi", "agent", "auto-name");
export const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

export interface AutoNameSettings {
	/** Model identifier in "provider/model-id" format */
	modelId?: string;
	/** Thinking/reasoning level for name generation */
	thinkingLevel?: ThinkingLevel;
}

const DEFAULT_SETTINGS: AutoNameSettings = {};

function loadRaw(): AutoNameSettings {
	try {
		const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
		const parsed = JSON.parse(data) as unknown;
		if (parsed && typeof parsed === "object") {
			return parsed as AutoNameSettings;
		}
	} catch {
		// 파일이 없거나 JSON 파싱 실패 시 기본값 사용
	}
	return { ...DEFAULT_SETTINGS };
}

export function loadSettings(): AutoNameSettings {
	return loadRaw();
}

export function saveSettings(settings: AutoNameSettings): void {
	fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
}

export function getSetting<K extends keyof AutoNameSettings>(key: K): AutoNameSettings[K] {
	return loadRaw()[key];
}

export function setSetting<K extends keyof AutoNameSettings>(key: K, value: AutoNameSettings[K]): void {
	const settings = loadRaw();
	if (value === undefined) {
		delete settings[key];
	} else {
		settings[key] = value;
	}
	saveSettings(settings);
}

/** 현재 설정값을 사람이 읽기 좋은 문자열로 포맷팅 */
export function formatSettings(settings: AutoNameSettings): string {
	const lines: string[] = [];
	lines.push(`모델: ${settings.modelId ?? "기본 (현재 세션 모델)"}`);
	lines.push(`추론 레벨: ${settings.thinkingLevel ?? "기본 (minimal)"}`);
	return lines.join("\n");
}
