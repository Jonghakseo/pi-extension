import { describe, expect, it } from "vitest";
import { isSubagentAsyncLaunchCommand, parseSubagentToolCommand } from "./cli.ts";

describe("subagent CLI batch/chain parsing", () => {
	it("parses batch with repeated --agent/--task blocks", () => {
		const parsed = parseSubagentToolCommand(
			'subagent batch --main --agent worker --task "A 작업" --agent reviewer --task "B 작업"',
		);

		expect(parsed).toEqual({
			type: "params",
			params: {
				asyncAction: "batch",
				contextMode: "main",
				runs: [
					{ agent: "worker", task: "A 작업" },
					{ agent: "reviewer", task: "B 작업" },
				],
			},
		});
	});

	it("parses chain into steps", () => {
		const parsed = parseSubagentToolCommand(
			'subagent chain --isolated --agent worker --task "1단계" --agent reviewer --task "2단계"',
		);

		expect(parsed).toEqual({
			type: "params",
			params: {
				asyncAction: "chain",
				contextMode: "isolated",
				steps: [
					{ agent: "worker", task: "1단계" },
					{ agent: "reviewer", task: "2단계" },
				],
			},
		});
	});

	it("rejects free text outside batch/chain task blocks", () => {
		const parsed = parseSubagentToolCommand(
			'subagent batch --agent worker --task "A" stray --agent reviewer --task "B"',
		);

		expect(parsed.type).toBe("error");
		if (parsed.type === "error") {
			expect(parsed.message).toContain("does not allow free text outside");
		}
	});

	it("returns concise no-help syntax error for unclosed quotes", () => {
		const parsed = parseSubagentToolCommand('subagent run worker -- "open quote');

		expect(parsed).toEqual({
			type: "error",
			message:
				"❌ Syntax error: Unclosed quote in command.\nClose the quote or wrap the task after `--` in matching quotes.",
			showHelp: false,
		});
	});

	it("rejects an entire comma-separated target when any run ID is invalid", () => {
		const malformed = parseSubagentToolCommand("subagent remove 12,typo");
		const emptySegment = parseSubagentToolCommand("subagent abort 12,,13");

		expect(malformed.type).toBe("error");
		expect(emptySegment.type).toBe("error");
	});

	it("parses status/detail with a batch/chain groupId", () => {
		expect(parseSubagentToolCommand("subagent status b_1712_abc")).toEqual({
			type: "params",
			params: { asyncAction: "status", groupId: "b_1712_abc" },
		});
		expect(parseSubagentToolCommand("subagent detail p_1712_xyz")).toEqual({
			type: "params",
			params: { asyncAction: "detail", groupId: "p_1712_xyz" },
		});
	});

	it("still parses numeric runId for status/detail", () => {
		expect(parseSubagentToolCommand("subagent status 12")).toEqual({
			type: "params",
			params: { asyncAction: "status", runId: 12 },
		});
	});

	it("rejects a non-numeric, non-group id for status", () => {
		const parsed = parseSubagentToolCommand("subagent status typo");
		expect(parsed.type).toBe("error");
	});

	it("treats batch and chain as async launch commands", () => {
		expect(isSubagentAsyncLaunchCommand("subagent batch --agent worker --task A --agent reviewer --task B")).toBe(true);
		expect(isSubagentAsyncLaunchCommand("subagent chain --agent worker --task A --agent reviewer --task B")).toBe(true);
		expect(isSubagentAsyncLaunchCommand("subagent status 12")).toBe(false);
	});
});
