import { describe, expect, it } from "vitest";
import { renderSubagentToolCall } from "./tool-render.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function renderCall(command: string, expanded = false): string {
	return renderSubagentToolCall({ command }, theme as never, { expanded })
		.render(240)
		.join("\n");
}

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
