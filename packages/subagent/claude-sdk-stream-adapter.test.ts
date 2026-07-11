/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import { describe, expect, it } from "vitest";
import { createClaudeSdkStreamAdapter } from "./claude-sdk-stream-adapter.ts";

describe("claude-sdk-stream-adapter", () => {
	it("converts SDK assistant/result messages into SingleResult", () => {
		const adapter = createClaudeSdkStreamAdapter();

		adapter.processMessage({
			type: "assistant",
			session_id: "sess-sdk-1",
			uuid: "msg-1",
			parent_tool_use_id: null,
			message: {
				role: "assistant",
				model: "claude-sonnet-4-6",
				content: [{ type: "text", text: "Hello from SDK" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		} as any);
		adapter.processMessage({
			type: "result",
			session_id: "sess-sdk-1",
			uuid: "result-1",
			is_error: false,
			stop_reason: "end_turn",
			result: "done",
			usage: { input_tokens: 10, output_tokens: 5 },
			total_cost_usd: 0.01,
			num_turns: 1,
		} as any);

		const result = adapter.toSingleResult("worker", "project", "run task", 0, 3, "");
		expect(result.runtime).toBe("claude");
		expect(result.claudeSessionId).toBe("sess-sdk-1");
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.role).toBe("assistant");
		expect(result.usage.cost).toBe(0.01);
		expect(result.step).toBe(3);
	});
});
