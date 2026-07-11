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

	it("treats batch and chain as async launch commands", () => {
		expect(isSubagentAsyncLaunchCommand("subagent batch --agent worker --task A --agent reviewer --task B")).toBe(true);
		expect(isSubagentAsyncLaunchCommand("subagent chain --agent worker --task A --agent reviewer --task B")).toBe(true);
		expect(isSubagentAsyncLaunchCommand("subagent status 12")).toBe(false);
	});
});
