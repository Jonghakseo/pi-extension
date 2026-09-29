import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { compileBrief } from "../src/core/brief.ts";
import { registerBeforeCompactHook } from "../src/hooks/before-compact.ts";

vi.mock("../src/core/settings.ts", () => ({
	loadSettings: () => ({
		overrideDefaultCompaction: true,
		smartKeepTail: false,
		continueAfterThresholdCompact: false,
		debug: false,
		skipForProviders: [],
		skipCustomTypes: [],
		rules: {},
		disableBuiltinRules: [],
	}),
}));

const assistantBase = {
	api: "messages",
	provider: "anthropic",
	model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	timestamp: 0,
};

let seq = 0;
const nextId = () => `e${++seq}`;
const userEntry = (text: string) => ({ type: "message", id: nextId(), message: { role: "user", content: text } });
const editEntry = (path: string) => ({
	type: "message",
	id: nextId(),
	message: {
		...assistantBase,
		role: "assistant",
		stopReason: "toolUse",
		content: [
			{ type: "toolCall", id: `tc-${seq}`, name: "edit", arguments: { path, edits: [{ oldText: "a", newText: "b" }] } },
		],
	},
});
const textEntry = (text: string) => ({
	type: "message",
	id: nextId(),
	message: { ...assistantBase, role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});
const noticeEntry = (customType: string, content: string, display = true) => ({
	type: "custom_message",
	id: nextId(),
	customType,
	content,
	display,
});

const runHook = (entries: any[], previousSummary?: string) => {
	const handlers = new Map<string, (...args: any[]) => any>();
	registerBeforeCompactHook({
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	return handlers.get("session_before_compact")!(
		{
			branchEntries: entries,
			customInstructions: "__pi_vcc__ keep:0",
			preparation: {
				previousSummary,
				tokensBefore: 5000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			},
		},
		{ cwd: "/repo", sessionManager: { getEntries: () => entries } },
	).compaction;
};

describe("extension notices in the brief", () => {
	const log = Array.from({ length: 60 }, (_, i) => `✔ Test case${i}() passed after 0.001 seconds.`).join("\n");

	it("keeps a notice's status line and outcome, dropping the log in between", () => {
		const out = compileBrief([
			{
				kind: "custom",
				customType: "bash-async-completion",
				text: `[bash_async 1830cdab] UI 테스트 실행: succeeded (exit 0) in 97s\n${log}\n** TEST SUCCEEDED **\nLog: /tmp/run.log`,
				sourceIndex: "c4",
			},
		]);
		expect(out).toContain("[bash_async 1830cdab] UI 테스트 실행: succeeded (exit 0) in 97s");
		expect(out).toContain("Log: /tmp/run.log (#c4)");
		expect(out).not.toContain("case30()");
		expect(out.split("\n").length).toBeLessThan(20);
	});

	it("keeps a verdict that opens the body of a review result", () => {
		const out = compileBrief([
			{
				kind: "custom",
				customType: "subagent-batch",
				text: `[subagent-batch#b_1] completed\nRuns: #2 done\n\n#2 reviewer\n- Verdict: FAIL (P1:2)\n${log}\nNext: fix F1 and F2.`,
			},
		]);
		expect(out).toContain("Verdict: FAIL (P1:2)");
		expect(out).toContain("Next: fix F1 and F2.");
	});

	it("renders model-only notices (display:false) as their first line", () => {
		const out = compileBrief([
			{
				kind: "custom",
				customType: "state-snapshot",
				display: false,
				text: "[todo-reminder] 현재 todo 상태 스냅샷\n- task-1 진행 중\n- task-2 대기",
			},
		]);
		expect(out).toBe("[custom:state-snapshot]\n[todo-reminder] 현재 todo 상태 스냅샷");
	});
});

describe("compaction hook", () => {
	it("gives custom messages #cN refs that do not shift message refs", () => {
		seq = 0;
		const entries = [
			userEntry("리팩토링 작업 수정해줘"),
			noticeEntry("subagent-tool", "[subagent:worker#1] completed\n결과: 파서 수정 완료"),
			textEntry("워커 결과를 확인했습니다."),
			noticeEntry("bash-async-completion", "[bash_async 1] 테스트: succeeded (exit 0)"),
			textEntry("테스트도 통과했습니다."),
		];
		const { summary } = runHook(entries);
		expect(summary).toContain("결과: 파서 수정 완료 (#c0)");
		expect(summary).toContain("[bash_async 1] 테스트: succeeded (exit 0) (#c1)");
		expect(summary).toContain("워커 결과를 확인했습니다. (#1)");
		expect(summary).toContain("테스트도 통과했습니다. (#2)");
	});

	it("survives custom content of an unexpected shape and leaves recall output out", () => {
		seq = 0;
		const entries = [
			userEntry("정리 작업 수정해줘"),
			{ type: "custom_message", id: nextId(), customType: "odd-extension", content: { text: "not an array" } },
			noticeEntry("vcc-recall", '3 matches for "정리":\n\n#0 [user] 정리 작업 수정해줘'),
			textEntry("정리 완료"),
		];
		const { summary } = runHook(entries);
		expect(summary).toContain("정리 완료");
		expect(summary).not.toContain("[custom:vcc-recall]");
	});

	it("builds on the last pi-vcc-ko state when a foreign compaction came after it", () => {
		seq = 0;
		const entries: any[] = [
			userEntry("첫 작업 수정해줘"),
			...Array.from({ length: 12 }, (_, i) => editEntry(`/repo/src/a${i}.ts`)),
		];
		const first = runHook(entries);
		entries.push({
			type: "compaction",
			id: nextId(),
			firstKeptEntryId: "",
			summary: first.summary,
			details: first.details,
		});
		entries.push(userEntry("두 번째 작업 수정해줘"), editEntry("/repo/src/b.ts"));
		const foreignSummary = "## Goal\n두 번째 작업\n\n## Progress\n- b.ts 수정";
		entries.push({ type: "compaction", id: nextId(), firstKeptEntryId: "", summary: foreignSummary, details: {} });
		entries.push(userEntry("세 번째 작업 수정해줘"), editEntry("/repo/src/c.ts"), textEntry("완료"));
		const third = runHook(entries, foreignSummary);
		expect(third.details.state.files.modified).toEqual([...first.details.state.files.modified, "/repo/src/c.ts"]);
	});

	it("persists file and commit state and the next compaction builds on it", () => {
		seq = 0;
		const entries: any[] = [
			userEntry("첫 작업 수정해줘"),
			...Array.from({ length: 12 }, (_, i) => editEntry(`/repo/src/a${i}.ts`)),
		];
		const first = runHook(entries);
		expect(first.details.version).toBe(3);
		expect(first.details.state.files.modified).toHaveLength(12);
		expect(first.details.sections).toEqual(["Session Goal", "Files And Changes", "Brief Transcript"]);

		entries.push({
			type: "compaction",
			id: nextId(),
			firstKeptEntryId: "",
			summary: first.summary,
			details: first.details,
		});
		entries.push(userEntry("두 번째 작업 수정해줘"), editEntry("/repo/src/b.ts"), textEntry("완료"));
		const second = runHook(entries, first.summary);
		expect(second.details.state.files.modified).toHaveLength(13);
		expect(second.details.state.files.modified.at(-1)).toBe("/repo/src/b.ts");
		const files = second.summary.match(/\[Files And Changes\]\n([\s\S]*?)(?=\n\n)/)?.[1] ?? "";
		// Newest last, relative to cwd, with the older ones counted.
		expect(files).toMatch(/src\/b\.ts \(\+3 earlier\)$/);
		expect(files).not.toContain("/repo/");
	});
});
