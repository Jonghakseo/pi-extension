import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import clipboardExtension from "./index.ts";

describe("clipboard extension", () => {
	it("returns an error for empty text", async () => {
		const apiMock = createExtensionApiMock();
		clipboardExtension(apiMock.api);
		const tool = apiMock.getTool("copy_to_clipboard");
		const execute = tool.execute;
		if (!execute) throw new Error("copy_to_clipboard execute is missing");

		const result = await execute("call-1", { text: "   " }, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(result).toMatchObject({
			details: { success: false, error: "empty_text" },
		});
	});

	it("writes an OSC52 payload for valid text", async () => {
		const apiMock = createExtensionApiMock();
		clipboardExtension(apiMock.api);
		const tool = apiMock.getTool("copy_to_clipboard");
		const execute = tool.execute;
		if (!execute) throw new Error("copy_to_clipboard execute is missing");

		const notify = vi.fn();
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		const result = await execute("call-2", { text: "hello" }, undefined, undefined, {
			hasUI: true,
			ui: { notify },
		} as unknown as ExtensionContext);

		expect(writeSpy).toHaveBeenCalledWith("\u001b]52;c;aGVsbG8=\u0007");
		expect(notify).toHaveBeenCalledWith("Copied 5 characters to clipboard", "info");
		expect(result).toMatchObject({
			details: { success: true, characterCount: 5, preview: "hello" },
		});
	});

	it("returns the success payload even when UI is unavailable", async () => {
		const apiMock = createExtensionApiMock();
		clipboardExtension(apiMock.api);
		const tool = apiMock.getTool("copy_to_clipboard");
		const execute = tool.execute;
		if (!execute) throw new Error("copy_to_clipboard execute is missing");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const longText = "x".repeat(120);
		const result = await execute("call-3", { text: longText }, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(result).toMatchObject({
			details: { success: true, characterCount: 120, preview: `${"x".repeat(100)}...` },
		});
	});

	it("returns an error when stdout write fails", async () => {
		const apiMock = createExtensionApiMock();
		clipboardExtension(apiMock.api);
		const tool = apiMock.getTool("copy_to_clipboard");
		const execute = tool.execute;
		if (!execute) throw new Error("copy_to_clipboard execute is missing");

		vi.spyOn(process.stdout, "write")
			.mockImplementationOnce(() => {
				throw new Error("no tty");
			})
			.mockImplementationOnce(() => {
				throw "boom";
			});

		const errorResult = await execute("call-4", { text: "hello" }, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);
		const unknownResult = await execute("call-5", { text: "hello" }, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(errorResult).toMatchObject({
			content: [{ type: "text", text: "Failed to copy to clipboard: no tty" }],
			details: { success: false, error: "no tty" },
		});
		expect(unknownResult).toMatchObject({
			content: [{ type: "text", text: "Failed to copy to clipboard: Unknown error" }],
			details: { success: false, error: "Unknown error" },
		});
	});
});
