import { describe, expect, it } from "vitest";
import {
	buildNameContext,
	extractNameFromResult,
	extractSessionFilePath,
	formatNameStatus,
	isSubagentSessionPath,
	MAX_MESSAGE_LENGTH,
	MAX_NAME_LENGTH,
	MAX_STATUS_CHARS,
	SUBAGENT_SESSION_DIR,
} from "./auto-name-utils.ts";

describe("auto-name utils", () => {
	it("detects subagent session paths", () => {
		expect(isSubagentSessionPath(`${SUBAGENT_SESSION_DIR}/child/session.json`)).toBe(true);
		expect(isSubagentSessionPath("/tmp/session.json")).toBe(false);
		expect(isSubagentSessionPath(undefined)).toBe(false);
	});

	it("extracts and sanitizes the session file path", () => {
		const sessionManager = {
			getSessionFile: () => "\n /tmp/example.json \t",
		};
		expect(extractSessionFilePath(sessionManager)).toBe("/tmp/example.json");
		expect(extractSessionFilePath({ getSessionFile: () => undefined })).toBeUndefined();
		expect(
			extractSessionFilePath({
				getSessionFile: () => {
					throw new Error("boom");
				},
			}),
		).toBeUndefined();
	});

	it("formats the status line into a single clipped line", () => {
		const noisy = `  alpha\n beta\t${"x".repeat(MAX_STATUS_CHARS)}  `;
		const formatted = formatNameStatus(noisy);
		expect(formatted).not.toContain("\n");
		expect(formatted.length).toBeLessThanOrEqual(MAX_STATUS_CHARS);
	});

	it("builds the name context with truncation", () => {
		const message = "m".repeat(MAX_MESSAGE_LENGTH + 25);
		const context = buildNameContext(message);
		expect(context).toBe(`사용자 메시지: ${message.slice(0, MAX_MESSAGE_LENGTH)}`);
	});

	it("extracts text-only content and clips the result length", () => {
		const result = extractNameFromResult([
			{ type: "text", text: `  ${"a".repeat(MAX_NAME_LENGTH)} ` },
			{ type: "image", text: "ignored" },
			{ type: "text", text: "suffix" },
		]);
		expect(result).toBe(`${"a".repeat(MAX_NAME_LENGTH)}`);
	});
});
