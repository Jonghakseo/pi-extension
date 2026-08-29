import { describe, expect, it } from "vitest";
import { parseCronToolCommand } from "./cli.js";

describe("cron CLI parser", () => {
	it("returns help for an empty cron command", () => {
		expect(parseCronToolCommand("cron")).toEqual({ type: "help" });
	});

	it("parses simple status/list commands", () => {
		expect(parseCronToolCommand("cron status")).toEqual({ type: "params", params: { action: "status" } });
		expect(parseCronToolCommand("cron list --include-prompt")).toEqual({
			type: "params",
			params: { action: "list", includePrompt: true },
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
		expect(parseCronToolCommand("cron uninstall-launchd --yes")).toEqual({
			type: "params",
			params: { action: "uninstall_launchd", yes: true },
		});
	});

	it("rejects update without id", () => {
		const result = parseCronToolCommand('cron update --schedule "0 9 * * *"');
		expect(result.type).toBe("error");
		if (result.type === "error") expect(result.message).toContain("update requires <id>");
	});
});
