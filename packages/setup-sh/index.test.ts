import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { __test__ } from "./index.ts";

const plainTheme = { fg: (_color: string, text: string) => text };

describe("setup-sh extension utilities", () => {
	it("finds setup.sh only in the current working directory", () => {
		const root = mkdtempSync(join(tmpdir(), "setup-sh-test-"));
		try {
			const nested = join(root, "backend", "src");
			mkdirSync(nested, { recursive: true });
			writeFileSync(join(root, "setup.sh"), "#!/bin/zsh\necho root\n", "utf-8");

			expect(__test__.findSetupPath(nested)).toBeNull();
			expect(__test__.resolveSetupContext(nested)).toBeNull();

			writeFileSync(join(nested, "setup.sh"), "#!/bin/zsh\necho nested\n", "utf-8");
			const realNested = realpathSync(nested);
			const realSetupPath = join(realNested, "setup.sh");

			expect(__test__.findSetupPath(nested)).toBe(realSetupPath);
			const context = __test__.resolveSetupContext(nested);
			expect(context?.repoRoot).toBe(realNested);
			expect(context?.setupPath).toBe(realSetupPath);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders the widget as at most one truncated line", () => {
		const lines = __test__.renderWidgetLine(
			{
				visible: true,
				status: "running",
				repoRoot: "/tmp/product",
				owner: "other",
				startedAt: new Date(Date.now() - 125_000).toISOString(),
				message: "pnpm install --frozen-lockfile is still running with a very long output line",
			},
			48,
			plainTheme,
		);

		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(48);
		expect(lines[0]).toContain("elsewhere");
	});

	it("keeps failed status actionable", () => {
		const line = __test__.formatSnapshotLine(
			{
				visible: true,
				status: "failed",
				repoRoot: "/tmp/product",
				owner: "self",
				exitCode: 1,
				message: "Infisical 로그인이 필요합니다.",
			},
			plainTheme,
		);

		expect(line).toContain("setup.sh failed exit 1");
		expect(line).toContain("/setup-sh");
	});

	it("strips common ANSI control sequences from log lines", () => {
		expect(__test__.stripAnsi("\u001B[31mred\u001B[0m plain")).toBe("red plain");
		expect(__test__.stripAnsi("before \u001B]8;;https://example.com\u0007link\u001B]8;;\u0007 after")).toBe(
			"before link after",
		);
	});

	it("quotes shell arguments safely", () => {
		expect(__test__.shellQuote("/tmp/it's ok/setup.sh")).toBe("'/tmp/it'\\''s ok/setup.sh'");
	});

	it("does not use zsh's readonly status variable in the wrapper", () => {
		const script = __test__.createWrapperScript(
			{
				repoKey: "repo",
				repoRoot: "/tmp/repo",
				setupPath: "/tmp/repo/setup.sh",
				setupHash: "hash",
				runId: "run",
				pid: 123,
				coordinatorPid: 456,
				startedAt: "2026-04-27T00:00:00.000Z",
				logPath: "/tmp/setup.log",
				exitPath: "/tmp/setup.exit.json",
				lockPath: "/tmp/setup.lock.json",
			},
			"/tmp/wrapper.zsh",
		);

		expect(script).toContain('setup_status="success"');
		expect(script).not.toContain("local status=");
	});
});
