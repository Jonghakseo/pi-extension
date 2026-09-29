import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	invalidateConfig,
	loadConfigSection,
	normalizeApiKey,
	normalizeBoolean,
	normalizePositiveNumber,
	normalizeString,
	setConfigPathForTests,
} from "./config.js";

// ─── normalizeApiKey ─────────────────────────────────────────────────────────

describe("normalizeApiKey", () => {
	it("should return null for non-string values", () => {
		expect(normalizeApiKey(undefined)).toBeNull();
		expect(normalizeApiKey(123)).toBeNull();
		expect(normalizeApiKey(true)).toBeNull();
	});

	it("should return null for empty string", () => {
		expect(normalizeApiKey("")).toBeNull();
		expect(normalizeApiKey("   ")).toBeNull();
	});

	it("should return trimmed string for valid API keys", () => {
		expect(normalizeApiKey("sk-abc123")).toBe("sk-abc123");
		expect(normalizeApiKey("  sk-abc123  ")).toBe("sk-abc123");
	});
});

// ─── normalizeBoolean ────────────────────────────────────────────────────────

describe("normalizeBoolean", () => {
	it("should return boolean values as-is", () => {
		expect(normalizeBoolean(true, false)).toBe(true);
		expect(normalizeBoolean(false, true)).toBe(false);
	});

	it("should fall back to default for non-boolean", () => {
		expect(normalizeBoolean("true", false)).toBe(false);
		expect(normalizeBoolean(1, false)).toBe(false);
		expect(normalizeBoolean(undefined, true)).toBe(true);
		expect(normalizeBoolean(null, false)).toBe(false);
	});
});

// ─── normalizeString ─────────────────────────────────────────────────────────

describe("normalizeString", () => {
	it("should return fallback for non-string values", () => {
		expect(normalizeString(undefined, "default")).toBe("default");
		expect(normalizeString(123, "default")).toBe("default");
	});

	it("should return fallback for empty/whitespace strings", () => {
		expect(normalizeString("", "default")).toBe("default");
		expect(normalizeString("   ", "default")).toBe("default");
	});

	it("should return trimmed string for valid strings", () => {
		expect(normalizeString("hello", "default")).toBe("hello");
		expect(normalizeString("  hello  ", "default")).toBe("hello");
	});
});

// ─── normalizePositiveNumber ─────────────────────────────────────────────────

describe("normalizePositiveNumber", () => {
	it("should return fallback for non-number values", () => {
		expect(normalizePositiveNumber("10", 50)).toBe(50);
		expect(normalizePositiveNumber(undefined, 50)).toBe(50);
	});

	it("should return fallback for NaN/Infinity", () => {
		expect(normalizePositiveNumber(NaN, 50)).toBe(50);
		expect(normalizePositiveNumber(Infinity, 50)).toBe(50);
	});

	it("should return fallback for zero and negative", () => {
		expect(normalizePositiveNumber(0, 50)).toBe(50);
		expect(normalizePositiveNumber(-10, 50)).toBe(50);
	});

	it("should return valid positive numbers", () => {
		expect(normalizePositiveNumber(10, 50)).toBe(10);
		expect(normalizePositiveNumber(350.5, 50)).toBe(350.5);
	});
});

// ─── loadConfigSection / invalidateConfig ─────────────────────────────────────

describe("loadConfigSection", () => {
	beforeEach(() => {
		invalidateConfig(); // Clear all caches before each test
	});

	afterEach(() => {
		setConfigPathForTests(null);
		invalidateConfig(); // Clean up
	});

	it("should return defaults when config file does not exist", () => {
		// Mock existsSync to return false
		vi.doMock("node:fs", () => ({
			existsSync: () => false,
			readFileSync: () => "",
		}));
		const result = loadConfigSection("test-key", { value: 42 }, (raw) => ({ value: (raw.exaApiKey as number) ?? 42 }));
		expect(result).toEqual({ value: 42 });
	});

	it("should return defaults when config file does not exist (no mock)", () => {
		// Use a temporary path that definitely doesn't exist
		// Since CONFIG_PATH is hardcoded, we test via cache invalidation
		invalidateConfig();
		const result = loadConfigSection("nonexistent-test", { value: "default" } as { value: string }, (raw) => ({
			value: ((raw as Record<string, unknown>).someKey as string) ?? "default",
		}));
		expect(result).toEqual({ value: "default" });
	});

	it("should cache results and return same object on second call", () => {
		invalidateConfig();
		const first = loadConfigSection("cache-test", { value: "cached" }, (raw) => ({
			value: ((raw as Record<string, unknown>).someKey as string) ?? "cached",
		}));
		const second = loadConfigSection("cache-test", { value: "cached" }, (raw) => ({
			value: ((raw as Record<string, unknown>).someKey as string) ?? "cached",
		}));
		expect(first).toBe(second); // Same reference
	});

	it("should throw descriptive error for malformed JSON", () => {
		const tempDir = join(tmpdir(), `pi-config-test-${Date.now()}`);
		const tempFile = join(tempDir, "web-search.json");

		mkdirSync(tempDir, { recursive: true });
		writeFileSync(tempFile, "{ invalid json");
		setConfigPathForTests(tempFile);

		expect(() => loadConfigSection("invalid-json", { value: "default" }, () => ({ value: "unused" }))).toThrow(
			new RegExp(`Failed to parse ${tempFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`),
		);

		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should reload from disk after cache invalidation", () => {
		const tempDir = join(tmpdir(), `pi-config-cache-test-${Date.now()}`);
		const tempFile = join(tempDir, "web-search.json");
		mkdirSync(tempDir, { recursive: true });
		setConfigPathForTests(tempFile);

		writeFileSync(tempFile, JSON.stringify({ exaApiKey: "first" }));
		const first = loadConfigSection("reload-test", { value: "default" }, (raw) => ({
			value: normalizeString(raw.exaApiKey, "default"),
		}));

		writeFileSync(tempFile, JSON.stringify({ exaApiKey: "second" }));
		const cached = loadConfigSection("reload-test", { value: "default" }, (raw) => ({
			value: normalizeString(raw.exaApiKey, "default"),
		}));
		invalidateConfig("reload-test");
		const reloaded = loadConfigSection("reload-test", { value: "default" }, (raw) => ({
			value: normalizeString(raw.exaApiKey, "default"),
		}));

		expect(first.value).toBe("first");
		expect(cached.value).toBe("first");
		expect(reloaded.value).toBe("second");

		rmSync(tempDir, { recursive: true, force: true });
	});
});

describe("invalidateConfig", () => {
	it("should clear all caches when called without arguments", () => {
		loadConfigSection("invalidate-all-test", { value: "first" }, () => ({ value: "first" }));
		invalidateConfig();
		// After invalidation, a new call should produce a fresh object
		const result = loadConfigSection("invalidate-all-test", { value: "second" }, () => ({ value: "second" }));
		expect(result.value).toBe("second");
	});

	it("should clear specific key cache when called with key", () => {
		loadConfigSection("invalidate-key-test", { value: "first" }, () => ({ value: "first" }));
		loadConfigSection("keep-this-key", { value: "kept" }, () => ({ value: "kept" }));

		invalidateConfig("invalidate-key-test");

		// The specific key should be re-fetched
		const result = loadConfigSection("invalidate-key-test", { value: "reloaded" }, () => ({ value: "reloaded" }));
		expect(result.value).toBe("reloaded");
	});
});
