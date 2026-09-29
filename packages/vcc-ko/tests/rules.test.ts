import { describe, expect, it } from "vitest";
import { filterNoise } from "../src/core/filter-noise.ts";
import { builtinRules, compilePattern, compileRules } from "../src/core/rules.ts";
import { extractGoals } from "../src/extract/goals.ts";
import { extractPreferences } from "../src/extract/preferences.ts";
import type { NormalizedBlock } from "../src/types.ts";

const user = (text: string): NormalizedBlock => ({ kind: "user", text });

describe("compileRules", () => {
	it("내장 규칙만으로 구성된 기본 세트를 만든다", () => {
		const { rules, errors } = compileRules();
		expect(errors).toEqual([]);
		expect(rules.agentNotices.length).toBeGreaterThan(0);
		expect(rules.goalExclusions.length).toBeGreaterThan(0);
		expect(rules.blockerExclusions.length).toBeGreaterThan(0);
		expect(rules.taskVerbs.length).toBeGreaterThan(0);
		expect(rules.preferencePatterns.length).toBeGreaterThan(0);
	});

	it("사용자 규칙을 내장 규칙 뒤에 추가한다", () => {
		const { rules } = compileRules({ agentNotices: ["테스트봇 공지"], goalExclusions: ["^무시해줘"] });
		expect(rules.agentNotices.some((re) => re.source === "테스트봇 공지")).toBe(true);
		expect(rules.goalExclusions.some((re) => re.source === "^무시해줘")).toBe(true);
		// 내장 규칙은 유지된다
		expect(rules.agentNotices.length).toBe(builtinRules().agentNotices.length + 1);
	});

	it("무효 정규식은 제외하고 errors로 보고한다", () => {
		const { rules, errors } = compileRules({ goalExclusions: ["([잘못된"] });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("goalExclusions");
		expect(rules.goalExclusions.some((re) => re.source === "([잘못된")).toBe(false);
	});

	it("disableBuiltinRules로 그룹 전체를 끈다", () => {
		const { rules } = compileRules({ agentNotices: ["내 커스텀 공지"] }, ["agentNotices"]);
		expect(rules.agentNotices).toHaveLength(1);
		expect(rules.agentNotices[0].source).toBe("내 커스텀 공지");
		// 다른 그룹은 영향 없음
		expect(rules.goalExclusions.length).toBe(builtinRules().goalExclusions.length);
	});

	it("compilePattern은 대소문자 무시 플래그로 컴파일한다", () => {
		const re = compilePattern("ERROR:");
		expect(re?.test("error: something")).toBe(true);
	});
});

describe("주입 규칙 동작", () => {
	it("커스텀 agentNotices가 해당 블록을 드롭한다", () => {
		const { rules } = compileRules({ agentNotices: ["\\[테스트 하네스 공지\\]"] });
		const blocks = [user("[테스트 하네스 공지] 자동 생성된 안내입니다."), user("실제 요청입니다")];
		expect(filterNoise(blocks, rules)).toHaveLength(1);
	});

	it("커스텀 goalExclusions가 목표 라인을 제외한다", () => {
		const { rules } = compileRules({ goalExclusions: ["^표준 인사말:"] });
		const blocks = [user("표준 인사말: 안녕하세요 반갑습니다\n로그인 버그 고쳐줘")];
		const goals = extractGoals(blocks, rules);
		expect(goals).toEqual(["로그인 버그 고쳐줘"]);
	});

	it("커스텀 taskVerbs가 후속 지시를 최신 요청으로 추적한다", () => {
		const { rules } = compileRules({ taskVerbs: ["배포준비"] });
		const blocks: NormalizedBlock[] = [
			user("리팩토링 작업 시작했어"),
			{ kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
			user("이제 배포준비 해줘"),
		];
		const goals = extractGoals(blocks, rules);
		expect(goals).toContain("[Latest request]");
	});

	it("커스텀 preferencePatterns가 선호를 추출한다", () => {
		const { rules } = compileRules({ preferencePatterns: ["우리 팀은\\s"] });
		const blocks = [user("우리 팀은 컨벤션 문서를 먼저 확인합니다")];
		expect(extractPreferences(blocks, rules)).toHaveLength(1);
	});

	it("기본 규칙(미주입)은 기존 동작을 유지한다", () => {
		const blocks = [user("This message was not sent by the user. Bootstrap notice.")];
		expect(filterNoise(blocks)).toEqual([]);
	});
});
