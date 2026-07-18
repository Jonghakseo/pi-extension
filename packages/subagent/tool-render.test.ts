import { describe, expect, it } from "vitest";
import { SUBAGENT_STRONG_WAIT_MESSAGE } from "./constants.ts";
import {
	renderListAgentsCall,
	renderListAgentsResult,
	renderSubagentToolCall,
	renderSubagentToolResult,
} from "./tool-render.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function renderComponent(component: { render(width: number): string[] }): string {
	return component
		.render(240)
		.map((line) => line.trimEnd())
		.join("\n");
}

function renderCall(command: string, expanded = false): string {
	return renderComponent(renderSubagentToolCall({ command }, theme as never, { expanded }));
}

describe("list-agents tool rendering", () => {
	const fullText = [
		"Available subagents",
		"",
		"worker [user] · model: test · thinking: medium · tools: read,bash",
		"reviewer [user] · model: test · thinking: high · tools: read",
		"verifier [user] · model: test · thinking: medium · tools: read,bash",
		"searcher [user] · model: test · thinking: low · tools: read",
	].join("\n");
	const details = {
		agents: [{ name: "worker" }, { name: "reviewer" }, { name: "verifier" }, { name: "searcher" }],
	};

	it("shows agent count and up to three names when collapsed", () => {
		const call = renderComponent(renderListAgentsCall({}, theme as never));
		const result = renderComponent(
			renderListAgentsResult(
				{ content: [{ type: "text", text: fullText }], details },
				{ expanded: false },
				theme as never,
			),
		);

		expect(call).toContain("list-agents");
		expect(result).toContain("✓ 4 agents · worker, reviewer, verifier, +1");
		expect(result).not.toContain("model: test");
	});

	it("keeps the original agent list when expanded", () => {
		const rendered = renderComponent(
			renderListAgentsResult(
				{ content: [{ type: "text", text: fullText }], details },
				{ expanded: true },
				theme as never,
			),
		);

		expect(rendered).toContain(fullText);
		expect(rendered).toContain("model: test");
		expect(rendered).not.toContain("✓ 4 agents");
	});
});

describe("subagent async launch result rendering", () => {
	const launchMessages = [
		"Started async subagent run #5 (worker).",
		"Started async subagent batch b_1234_abcd (3 runs).",
		"Started async subagent chain p_1234_abcd (3 steps).",
	];

	for (const launchMessage of launchMessages) {
		it(`hides the anti-poll footer when collapsed: ${launchMessage}`, () => {
			const fullText = `${launchMessage} ${SUBAGENT_STRONG_WAIT_MESSAGE}`;
			const collapsed = renderComponent(
				renderSubagentToolResult({ content: [{ type: "text", text: fullText }] }, { expanded: false }, theme as never),
			);
			const expanded = renderComponent(
				renderSubagentToolResult({ content: [{ type: "text", text: fullText }] }, { expanded: true }, theme as never),
			);

			expect(collapsed).toBe(launchMessage);
			expect(collapsed).not.toContain("Do not poll");
			expect(expanded.replace(/\n/g, " ")).toBe(fullText);
		});
	}

	it("also hides the footer from running status responses", () => {
		const fullText = `Run #5 is still running.\n${SUBAGENT_STRONG_WAIT_MESSAGE}`;
		const collapsed = renderComponent(
			renderSubagentToolResult({ content: [{ type: "text", text: fullText }] }, { expanded: false }, theme as never),
		);

		expect(collapsed).toBe("Run #5 is still running.");
		expect(collapsed).not.toContain("Do not poll");
	});
});

describe("renderSubagentToolCall", () => {
	it("renders a compact single-run summary when collapsed", () => {
		const command = 'subagent run worker --main -- "Implement retry handling and run tests"';
		const rendered = renderCall(command);

		expect(rendered).toContain("subagent cli");
		expect(rendered).toContain("run · worker · main");
		expect(rendered).toContain("Implement retry handling and run tests");
		expect(rendered).not.toContain("subagent run worker --main");
	});

	it("renders batch jobs as compact parallel lanes when collapsed", () => {
		const command =
			'subagent batch --main --agent worker --task "Implement timer" --agent reviewer --task "Review protocol" --agent tester --task "Run integration tests"';
		const rendered = renderCall(command);

		expect(rendered).toContain("batch · main · 3 parallel");
		expect(rendered).toContain("∥ worker    Implement timer");
		expect(rendered).toContain("∥ reviewer  Review protocol");
		expect(rendered).toContain("∥ tester    Run integration tests");
		expect(rendered).not.toContain("--agent");
	});

	it("renders chain steps as compact nested lines when collapsed", () => {
		const command =
			'subagent chain --agent worker --task "Implement timer" --agent reviewer --task "Review protocol" --agent tester --task "Run integration tests"';
		const rendered = renderCall(command);

		expect(rendered).toContain("chain · isolated · 3 sequential");
		expect(rendered).toContain("1 worker    Implement timer");
		expect(rendered).toContain("└─ 2 reviewer  Review protocol");
		expect(rendered).toContain("   └─ 3 tester    Run integration tests");
		expect(rendered).not.toContain("--task");
	});

	it("keeps the original command when expanded", () => {
		const command = 'subagent chain --agent worker --task "Implement timer" --agent reviewer --task "Review protocol"';
		const rendered = renderCall(command, true);

		expect(rendered).toContain(command);
		expect(rendered).not.toContain("chain · isolated · 2 sequential");
		expect(rendered).not.toContain("└─ 2 reviewer");
	});
});
