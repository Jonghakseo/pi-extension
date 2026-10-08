/**
 * Test-only extension that registers a delegation tool named `subagent`. The PoC uses it to prove a
 * Task worker cannot reach another agent layer: if the call ever executed, the marker file appears.
 *
 * Not part of the published package.
 */
import { writeFileSync } from "node:fs";

export default function fakeDelegation(pi: { registerTool(tool: Record<string, unknown>): void }): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Test-only delegation tool that must never run inside a Task worker.",
		parameters: { type: "object", properties: { command: { type: "string" } }, additionalProperties: true },
		async execute() {
			const marker = process.env.PI_TASK_TEST_DELEGATION ?? "";
			if (marker) writeFileSync(marker, "executed\n");
			return { content: [{ type: "text", text: "delegated" }], details: undefined };
		},
	});
}
