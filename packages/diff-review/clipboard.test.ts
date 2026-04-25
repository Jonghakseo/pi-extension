import { describe, expect, it } from "vitest";
import { type ClipboardCommandRunner, readSystemClipboard, writeSystemClipboard } from "./clipboard.ts";

describe("diff-review clipboard bridge", () => {
	it("reads from the macOS clipboard command", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const runner: ClipboardCommandRunner = (command, args) => {
			calls.push({ command, args });
			return { status: 0, stdout: "from clipboard" };
		};

		expect(readSystemClipboard({ platform: "darwin", runner })).toBe("from clipboard");
		expect(calls).toEqual([{ command: "pbpaste", args: [] }]);
	});

	it("writes text to the macOS clipboard command stdin", () => {
		const calls: Array<{ command: string; args: string[]; input?: string }> = [];
		const runner: ClipboardCommandRunner = (command, args, options) => {
			calls.push({ command, args, input: options.input });
			return { status: 0, stdout: "" };
		};

		writeSystemClipboard("copy me", { platform: "darwin", runner });

		expect(calls).toEqual([{ command: "pbcopy", args: [], input: "copy me" }]);
	});

	it("falls back to the next Linux clipboard command when the first is unavailable", () => {
		const calls: string[] = [];
		const runner: ClipboardCommandRunner = (command) => {
			calls.push(command);
			if (command === "wl-paste") {
				return { status: null, error: new Error("ENOENT") };
			}
			return { status: 0, stdout: "fallback clipboard" };
		};

		expect(readSystemClipboard({ platform: "linux", runner })).toBe("fallback clipboard");
		expect(calls).toEqual(["wl-paste", "xclip"]);
	});
});
