import * as fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatSettings,
	getSetting,
	loadSettings,
	SETTINGS_DIR,
	SETTINGS_FILE,
	saveSettings,
	setSetting,
} from "./settings.ts";

vi.mock("node:fs", () => ({
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

function resetMocks() {
	vi.mocked(fs.readFileSync).mockReset();
	vi.mocked(fs.writeFileSync).mockReset();
	vi.mocked(fs.mkdirSync).mockReset();
}

describe("settings", () => {
	beforeEach(() => {
		resetMocks();
	});

	it("loads default settings when file does not exist", () => {
		vi.mocked(fs.readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const s = loadSettings();
		expect(s).toEqual({});
	});

	it("loads parsed settings from file", () => {
		vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ modelId: "openai/gpt-4o", thinkingLevel: "high" }));
		const s = loadSettings();
		expect(s.modelId).toBe("openai/gpt-4o");
		expect(s.thinkingLevel).toBe("high");
	});

	it("loads default on invalid json", () => {
		vi.mocked(fs.readFileSync).mockReturnValue("not-json");
		const s = loadSettings();
		expect(s).toEqual({});
	});

	it("loads default on non-object parse", () => {
		vi.mocked(fs.readFileSync).mockReturnValue("123");
		const s = loadSettings();
		expect(s).toEqual({});
	});

	it("saves settings to correct path", () => {
		saveSettings({ modelId: "anthropic/claude-sonnet-4" });
		expect(fs.mkdirSync).toHaveBeenCalledWith(SETTINGS_DIR, { recursive: true });
		expect(fs.writeFileSync).toHaveBeenCalledWith(
			SETTINGS_FILE,
			JSON.stringify({ modelId: "anthropic/claude-sonnet-4" }, null, 2),
			"utf-8",
		);
	});

	it("setSetting adds a new key", () => {
		vi.mocked(fs.readFileSync).mockImplementation(() => {
			throw new Error("ENOENT");
		});
		setSetting("thinkingLevel", "medium");
		expect(fs.writeFileSync).toHaveBeenCalled();
		const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
		expect(written.thinkingLevel).toBe("medium");
	});

	it("setSetting removes key when value is undefined", () => {
		vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ modelId: "a/b", thinkingLevel: "low" }));
		setSetting("thinkingLevel", undefined);
		const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
		expect(written).not.toHaveProperty("thinkingLevel");
		expect(written.modelId).toBe("a/b");
	});

	it("setSetting updates existing key", () => {
		vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ thinkingLevel: "low" }));
		setSetting("thinkingLevel", "high");
		const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
		expect(written.thinkingLevel).toBe("high");
	});

	it("formatSettings shows defaults when unset", () => {
		const text = formatSettings({});
		expect(text).toContain("기본 (현재 세션 모델)");
		expect(text).toContain("기본 (minimal)");
	});

	it("formatSettings shows configured values", () => {
		const text = formatSettings({ modelId: "openai/gpt-4o", thinkingLevel: "high" });
		expect(text).toContain("openai/gpt-4o");
		expect(text).toContain("high");
	});

	it("getSetting retrieves a specific value", () => {
		vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ modelId: "openai/gpt-4o", thinkingLevel: "high" }));
		const val = getSetting("thinkingLevel");
		expect(val).toBe("high");
	});
});
