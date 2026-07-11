import { describe, expect, it } from "vitest";
import { buildMainContextText, stripTaskEchoFromMainContext, wrapTaskWithMainContext } from "./session.ts";

describe("stripTaskEchoFromMainContext", () => {
	it("removes exact task echo lines regardless of speaker prefix", () => {
		const task = "서브에이전트 호출시 메인 컨텍스트 넘기는 로직 찾아봐.";
		const context = ["[Recent Conversation]", `User: ${task}`, "Main agent: 다른 응답", `Main agent: ${task}`].join(
			"\n",
		);

		const result = stripTaskEchoFromMainContext(context, task);
		expect(result).not.toContain(`User: ${task}`);
		expect(result).not.toContain(`Main agent: ${task}`);
		expect(result).toContain("Main agent: 다른 응답");
	});

	it("removes subagent toolCall line containing the current task", () => {
		const task = "버그 원인 분석";
		const context = [
			"[Recent Conversation]",
			`Main agent ToolCall (subagent): {"command":"subagent run worker -- ${task}"}`,
			"Main agent: 분석 시작",
		].join("\n");

		const result = stripTaskEchoFromMainContext(context, task);
		expect(result).not.toContain("Main agent ToolCall (subagent)");
		expect(result).toContain("Main agent: 분석 시작");
	});

	it("keeps similar but non-exact lines", () => {
		const task = "로그인 성능 개선";
		const context = ["[Recent Conversation]", "User: 로그인 성능", "Main agent: 로그인 성능 개선안 정리"].join("\n");

		const result = stripTaskEchoFromMainContext(context, task);
		expect(result).toContain("User: 로그인 성능");
		expect(result).toContain("Main agent: 로그인 성능 개선안 정리");
	});
});

describe("main-context wrap integration", () => {
	it("does not duplicate latest request in HISTORY and REQUEST after stripping", () => {
		const task = "서브에이전트 호출시 메인 컨텍스트 넘기는 로직 찾아봐.";
		const entries = [
			{ type: "message", message: { role: "user", content: "이전 질문" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "이전 답변" }] } },
			{ type: "message", message: { role: "user", content: task } },
		];

		const ctx = { sessionManager: { getEntries: () => entries } } as {
			sessionManager: { getEntries: () => typeof entries };
		};
		const { text } = buildMainContextText(ctx);
		const stripped = stripTaskEchoFromMainContext(text, task);
		const wrapped = wrapTaskWithMainContext(task, stripped);

		expect(wrapped).toContain(`[REQUEST — AUTHORITATIVE]\n${task}`);
		expect(wrapped).not.toContain(`User: ${task}`);
	});
});
