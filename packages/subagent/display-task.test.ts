import { describe, expect, it } from "vitest";
import {
	buildSubagentDisplayTaskFallback,
	createDisplayTaskRefreshToken,
	isDisplayTaskRefreshTokenCurrent,
	normalizeSubagentTaskText,
	shouldSummarizeSubagentTask,
} from "./display-task.js";

describe("normalizeSubagentTaskText", () => {
	it("strips simple markdown noise", () => {
		expect(normalizeSubagentTaskText("**PR #2048** 검토\n`frontend/apps/admin/**`")).toBe(
			"PR #2048 검토 frontend/apps/admin/**",
		);
	});
});

describe("buildSubagentDisplayTaskFallback", () => {
	it("keeps tmp-only tasks close to the original text", () => {
		expect(
			buildSubagentDisplayTaskFallback(
				"read /tmp/pi-subagent-preview-self-heal-cycle2.md and /tmp/context.md and follow the instructions",
			),
		).toBe("read /tmp/pi-subagent-preview");
	});

	it("keeps the human task after tmp context removal", () => {
		expect(
			buildSubagentDisplayTaskFallback(
				"read /tmp/pr-review-instructions.md and /tmp/pr-chunk-8.md then inspect frontend/apps/admin/** for risky changes",
			),
		).toBe("inspect frontend/apps/admin/**");
	});

	it("drops continue prefix", () => {
		expect(buildSubagentDisplayTaskFallback("[continue #8] PR #2048 후속 검토")).toBe("PR #2048 후속 검토");
	});
});

describe("display task refresh token", () => {
	it("matches only the same launch snapshot", () => {
		const token = createDisplayTaskRefreshToken({ task: "task A", startedAt: 100 });
		expect(isDisplayTaskRefreshTokenCurrent({ task: "task A", startedAt: 100 }, token)).toBe(true);
		expect(isDisplayTaskRefreshTokenCurrent({ task: "task B", startedAt: 100 }, token)).toBe(false);
		expect(isDisplayTaskRefreshTokenCurrent({ task: "task A", startedAt: 101 }, token)).toBe(false);
	});
});

describe("shouldSummarizeSubagentTask", () => {
	it("requests llm summarization for tmp-context tasks", () => {
		expect(
			shouldSummarizeSubagentTask("read /tmp/pi-subagent-preview-self-heal-cycle2.md and follow the instructions", ""),
		).toBe(true);
	});

	it("skips llm summarization for already-clean labels", () => {
		expect(shouldSummarizeSubagentTask("RW 체크박스 래퍼에 z-float 적용", "RW 체크박스 래퍼에 z-float 적용")).toBe(
			false,
		);
	});
});
