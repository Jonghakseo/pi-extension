import { describe, expect, it } from "vitest";
import { failureHints, platformGuidance, resolveShellOptions, withFailureHints } from "./platform.ts";

describe("shell selection", () => {
	const resolve = (overrides: Parameters<typeof resolveShellOptions>[1]) =>
		resolveShellOptions("/work", { env: {}, exists: () => true, readSettings: () => ({}), ...overrides });

	it("prefers Homebrew bash on macOS when nothing is configured", () => {
		expect(resolve({ platform: "darwin" }).shellPath).toBe("/opt/homebrew/bin/bash");
		expect(resolve({ platform: "darwin", exists: (path) => path === "/usr/local/bin/bash" }).shellPath).toBe(
			"/usr/local/bin/bash",
		);
		expect(resolve({ platform: "darwin", exists: () => false }).shellPath).toBeUndefined();
		expect(resolve({ platform: "linux" }).shellPath).toBeUndefined();
	});

	it("keeps pi's shell settings and lets the environment override the shell", () => {
		const readSettings = () => ({ shellPath: "/bin/zsh-bash", commandPrefix: "shopt -s expand_aliases" });
		expect(resolve({ platform: "darwin", readSettings })).toEqual(readSettings());
		expect(resolve({ platform: "darwin", readSettings, env: { PI_ENHANCED_BASH_SHELL: "/bin/bash" } })).toEqual({
			shellPath: "/bin/bash",
			commandPrefix: "shopt -s expand_aliases",
		});
	});

	it("warns about bash 3.2 only when macOS's own bash is in use", () => {
		expect(platformGuidance({}, "darwin")).toContain("bash 3.2");
		expect(platformGuidance({ shellPath: "/opt/homebrew/bin/bash" }, "darwin")).not.toContain("bash 3.2");
		expect(platformGuidance({ shellPath: "/opt/homebrew/bin/bash" }, "darwin")).toContain("sed -i ''");
		expect(platformGuidance({}, "linux")).toBe("");
	});
});

describe("BSD failure hints", () => {
	// Messages captured from macOS 27 tools and /bin/bash 3.2.
	it.each([
		['sed: 1: "f\n": invalid command code f', "sed -i ''"],
		["/bin/bash: timeout: command not found", "timeout parameter"],
		["grep: invalid option -- P", "grep -E"],
		["head: illegal line count -- 0", "sed '$d'"],
		["head: illegal line count -- -1", "sed '$d'"],
		["tail: illegal offset -- +x: Invalid argument", "-n +N"],
		["/bin/bash: mapfile: command not found", "while IFS= read"],
		["/bin/bash: line 0: declare: -A: invalid option", "associative arrays"],
		["date: illegal option -- d", "date -v"],
		["stat: illegal option -- c", "stat -f"],
		["find: -printf: unknown primary or operator", "-exec stat"],
	])("explains %j", (output, expected) => {
		expect(failureHints(output).join(" ")).toContain(expected);
	});

	it("leaves unrelated failures untouched", () => {
		expect(withFailureHints("npm ERR! missing script: test")).toBe("npm ERR! missing script: test");
	});
});
