import { describe, expect, it } from "vitest";
import { parseCronToolCommand } from "./cli.js";

describe("cron CLI parser", () => {
	it("returns help for an empty cron command", () => {
		expect(parseCronToolCommand("cron")).toEqual({ type: "help" });
	});

	it("parses simple status/list/history commands", () => {
		expect(parseCronToolCommand("cron status --scope project")).toEqual({
			type: "params",
			params: { action: "status", scope: "project" },
		});
		expect(parseCronToolCommand("cron list --scope session --include-prompt")).toEqual({
			type: "params",
			params: { action: "list", scope: "session", includePrompt: true },
		});
		expect(parseCronToolCommand("cron history --include-prompt")).toEqual({
			type: "params",
			params: { action: "history", includePrompt: true },
		});
	});

	it("parses upsert with quoted schedule and prompt markdown", () => {
		expect(
			parseCronToolCommand(
				'cron upsert --name "daily release" --kind cron --schedule "0 10 * * *" --cwd /tmp --once -- "# Prompt\\nRun checks"',
			),
		).toEqual({
			type: "params",
			params: {
				action: "upsert",
				name: "daily release",
				kind: "cron",
				schedule: "0 10 * * *",
				cwd: "/tmp",
				once: true,
				promptMarkdown: "# Prompt\nRun checks",
			},
		});
	});

	it("parses update with positional id and boolean false", () => {
		expect(parseCronToolCommand('cron update daily --schedule "30 9 * * 1-5" --once=false')).toEqual({
			type: "params",
			params: { action: "update", id: "daily", schedule: "30 9 * * 1-5", once: false },
		});
	});

	it("parses daemon aliases", () => {
		expect(parseCronToolCommand("cron install")).toEqual({
			type: "params",
			params: { action: "install_launchd" },
		});
		expect(parseCronToolCommand("cron start-daemon")).toEqual({
			type: "params",
			params: { action: "start_daemon" },
		});
		expect(parseCronToolCommand("cron update-runtime")).toEqual({
			type: "params",
			params: { action: "update_daemon" },
		});
		expect(parseCronToolCommand("cron uninstall-launchd --yes")).toEqual({
			type: "params",
			params: { action: "uninstall_launchd", yes: true },
		});
	});

	it("parses scope on id commands and rejects invalid scope values", () => {
		expect(parseCronToolCommand("cron remove daily --scope project")).toEqual({
			type: "params",
			params: { action: "remove", id: "daily", scope: "project" },
		});
		const invalid = parseCronToolCommand("cron list --scope everyone");
		expect(invalid.type).toBe("error");
	});

	it("rejects update without id", () => {
		const result = parseCronToolCommand('cron update --schedule "0 9 * * *"');
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toContain("update requires <id>");
	});

	it("parses guard options with nested quotes and an explicit empty guard", () => {
		expect(
			parseCronToolCommand(
				`cron upsert --name watch --kind cron --schedule "*/10 * * * *" --guard 'python3 ~/.w/check.py "Product PR" --cleanup-only' --guard-mode changed --guard-timeout 5000 -- "prompt"`,
			),
		).toEqual({
			type: "params",
			params: {
				action: "upsert",
				name: "watch",
				kind: "cron",
				schedule: "*/10 * * * *",
				guard: 'python3 ~/.w/check.py "Product PR" --cleanup-only',
				guardMode: "changed",
				guardTimeoutMs: 5000,
				promptMarkdown: "prompt",
			},
		});
		expect(parseCronToolCommand('cron update watch --guard ""')).toEqual({
			type: "params",
			params: { action: "update", id: "watch", guard: "" },
		});
		expect(parseCronToolCommand("cron update watch --guard= --enabled true")).toEqual({
			type: "params",
			params: { action: "update", id: "watch", guard: "", enabled: true },
		});
	});

	it("ignores empty quoted positionals and treats an empty verb as help", () => {
		expect(parseCronToolCommand('cron list ""')).toEqual({ type: "params", params: { action: "list" } });
		expect(parseCronToolCommand('cron ""')).toEqual({ type: "help" });
		expect(parseCronToolCommand('""')).toEqual({ type: "help" });
	});

	it("rejects malformed guard options", () => {
		expect(parseCronToolCommand("cron update watch --guard")).toMatchObject({ type: "error" });
		expect(parseCronToolCommand("cron update watch --guard --enabled true")).toMatchObject({ type: "error" });
		expect(parseCronToolCommand("cron update watch --guard-mode sometimes")).toMatchObject({
			type: "error",
			message: expect.stringContaining("exit, changed"),
		});
		expect(parseCronToolCommand("cron update watch --guard-timeout 0")).toMatchObject({ type: "error" });
		expect(parseCronToolCommand("cron update watch --guard-timeout 5s")).toMatchObject({ type: "error" });
		expect(parseCronToolCommand("cron update watch --guard-timeout 120001")).toMatchObject({
			type: "error",
			message: expect.stringContaining("120000"),
		});
		expect(parseCronToolCommand("cron update watch --guard-timeout 120000")).toMatchObject({ type: "params" });
		expect(parseCronToolCommand("cron update watch --guard --flag-first")).toMatchObject({
			type: "error",
			message: expect.stringContaining("--guard=<cmd>"),
		});
		expect(parseCronToolCommand("cron update watch --guard=--flag-first")).toEqual({
			type: "params",
			params: { action: "update", id: "watch", guard: "--flag-first" },
		});
	});
});
