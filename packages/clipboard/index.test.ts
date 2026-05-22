import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import clipboardExtension from "./index.ts";

const setPlatform = (platform: NodeJS.Platform) => {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
};

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

describe("paste_from_clipboard tool", () => {
	const originalPlatform = process.platform;

	beforeEach(() => {
		vi.mocked(spawnSync).mockReset();
	});

	afterEach(() => {
		setPlatform(originalPlatform);
	});

	const getPasteExecute = () => {
		const apiMock = createExtensionApiMock();
		clipboardExtension(apiMock.api);
		const tool = apiMock.getTool("paste_from_clipboard");
		const execute = tool.execute;
		if (!execute) throw new Error("paste_from_clipboard execute is missing");
		return execute;
	};

	it("reads from pbpaste on macOS and notifies via UI", async () => {
		setPlatform("darwin");
		vi.mocked(spawnSync).mockReturnValueOnce({
			status: 0,
			stdout: "hello clipboard",
			stderr: "",
		} as unknown as ReturnType<typeof spawnSync>);

		const execute = getPasteExecute();
		const notify = vi.fn();
		const result = await execute("call-1", {}, undefined, undefined, {
			hasUI: true,
			ui: { notify },
		} as unknown as ExtensionContext);

		expect(vi.mocked(spawnSync)).toHaveBeenCalledWith("pbpaste", [], { encoding: "utf-8" });
		expect(notify).toHaveBeenCalledWith("Pasted 15 characters from clipboard", "info");
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Pasted 15 characters from clipboard.\n\nhello clipboard" }],
			details: { success: true, characterCount: 15, preview: "hello clipboard" },
		});
	});

	it("truncates the preview when clipboard text is long and skips UI when unavailable", async () => {
		setPlatform("darwin");
		const long = "y".repeat(130);
		vi.mocked(spawnSync).mockReturnValueOnce({
			status: 0,
			stdout: long,
			stderr: "",
		} as unknown as ReturnType<typeof spawnSync>);

		const execute = getPasteExecute();
		const result = await execute("call-2", {}, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(result).toMatchObject({
			details: { success: true, characterCount: 130, preview: `${"y".repeat(100)}...` },
		});
	});

	it("falls back from xclip to wl-paste on Linux and tolerates missing stdio fields", async () => {
		setPlatform("linux");
		vi.mocked(spawnSync)
			.mockReturnValueOnce({
				status: null,
				error: new Error("ENOENT"),
			} as unknown as ReturnType<typeof spawnSync>)
			.mockReturnValueOnce({
				status: 0,
			} as unknown as ReturnType<typeof spawnSync>);

		const execute = getPasteExecute();
		const result = await execute("call-3", {}, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toBe("xclip");
		expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).toEqual(["-selection", "clipboard", "-o"]);
		expect(vi.mocked(spawnSync).mock.calls[1]?.[0]).toBe("wl-paste");
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Clipboard is empty." }],
			details: { success: false, error: "empty_clipboard" },
		});
	});

	it("uses PowerShell Get-Clipboard on Windows", async () => {
		setPlatform("win32");
		vi.mocked(spawnSync).mockReturnValueOnce({
			status: 0,
			stdout: "win text",
			stderr: "",
		} as unknown as ReturnType<typeof spawnSync>);

		const execute = getPasteExecute();
		const result = await execute("call-4", {}, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"],
			{ encoding: "utf-8" },
		);
		expect(result).toMatchObject({
			details: { success: true, characterCount: 8, preview: "win text" },
		});
	});

	it("returns an unsupported-platform error when no commands are available", async () => {
		setPlatform("aix");
		const execute = getPasteExecute();
		const result = await execute("call-5", {}, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Failed to paste from clipboard: Clipboard read is not supported on aix." }],
			details: { success: false, error: "Clipboard read is not supported on aix." },
		});
	});

	it("surfaces aggregated errors when every Linux command fails", async () => {
		setPlatform("linux");
		vi.mocked(spawnSync)
			.mockReturnValueOnce({
				status: 1,
				stdout: "",
				stderr: "no display",
			} as unknown as ReturnType<typeof spawnSync>)
			.mockReturnValueOnce({
				status: 2,
				stdout: "",
			} as unknown as ReturnType<typeof spawnSync>);

		const execute = getPasteExecute();
		const result = await execute("call-6", {}, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(result).toMatchObject({
			details: { success: false },
		});
		const details = (result as { details: { error: string } }).details;
		expect(details.error).toContain("xclip exited with 1: no display");
		expect(details.error).toContain("wl-paste exited with 2");
	});

	it("reports an unknown error when a non-Error value is thrown", async () => {
		setPlatform("darwin");
		vi.mocked(spawnSync).mockImplementationOnce(() => {
			throw "boom";
		});

		const execute = getPasteExecute();
		const result = await execute("call-7", {}, undefined, undefined, {
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(result).toMatchObject({
			content: [{ type: "text", text: "Failed to paste from clipboard: Unknown error" }],
			details: { success: false, error: "Unknown error" },
		});
	});
});
