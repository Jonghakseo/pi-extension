import { describe, expect, it } from "vitest";
import { buildSections } from "../src/core/build-sections.ts";
import { filterNoise } from "../src/core/filter-noise.ts";
import { extractGoals } from "../src/extract/goals.ts";
import { extractPreferences } from "../src/extract/preferences.ts";
import type { NormalizedBlock } from "../src/types.ts";

const user = (text: string, sourceIndex?: number): NormalizedBlock => ({ kind: "user", text, sourceIndex });

describe("session goal", () => {
	it("keeps the few requests before the latest one, each pointing back at its message", () => {
		const goals = extractGoals([
			user("로그인 버그 수정해줘", 1),
			user("회원가입 폼도 검증 추가해줘", 5),
			user("비밀번호 재설정 메일 템플릿 수정해줘", 9),
			user("관리자 페이지 권한 체크도 확인해줘", 14),
			user("마지막으로 배포 스크립트 정리해줘", 20),
		]);
		expect(goals[0]).toBe("로그인 버그 수정해줘");
		const earlier = goals.slice(goals.indexOf("[Earlier requests]") + 1, goals.indexOf("[Latest request]"));
		expect(earlier).toEqual([
			"회원가입 폼도 검증 추가해줘 (#5)",
			"비밀번호 재설정 메일 템플릿 수정해줘 (#9)",
			"관리자 페이지 권한 체크도 확인해줘 (#14)",
		]);
		expect(goals.at(-1)).toBe("마지막으로 배포 스크립트 정리해줘 (#20)");
	});

	it("reads the instruction written after an invoked skill, even if the manual has template lines", () => {
		const goals = extractGoals([
			user("리팩토링 작업 시작해줘"),
			user(
				'<skill name="show-me-your-work">\nFor each decision, append a row.\n출력:\n</skill>\n\n코드 수정은 워커에 위임하고 W2 직후 스트레스 인터뷰 진행해줘',
			),
		]);
		expect(goals.at(-1)).toContain("코드 수정은 워커에 위임");
	});

	it("keeps a long one-line instruction, clipped at a sentence boundary", () => {
		const line =
			"피클에서 생성된 세션의 비동기 작업 상태를 사용자에게 보여주고, 진행 중인 작업이 있으면 피클을 진행 중으로 유지해줘. " +
			"bash_async와 subagent 모두 같은 방식으로 처리하고, 기존 동기 호출 경로는 호환성을 위해 남겨줘. 설계 문서도 같이 갱신해줘. " +
			"완료되면 변경한 파일과 검증 결과를 정리해서 보고하고, 사용자가 직접 확인해야 하는 런타임 동작도 목록으로 남겨줘.";
		expect(line.length).toBeGreaterThan(200);
		const goals = extractGoals([user(line)]);
		expect(goals).toHaveLength(1);
		expect(goals[0].length).toBeLessThanOrEqual(200);
		expect(goals[0].startsWith("피클에서 생성된 세션의")).toBe(true);
	});

	it("still rejects a long pasted log line", () => {
		const log = `2026-09-27 21:31:42.431 xcodebuild[24038:17962338] [MT] IDETestOperationsObserverDebug: ${"90.053 elapsed -- Testing started completed. ".repeat(5)}`;
		expect(extractGoals([user(log)])).toEqual([]);
	});

	it("uses the request section of a structured delegation prompt, not its instructions or history", () => {
		const prompt = [
			"[GENERAL INSTRUCTION — AUTHORITATIVE]",
			"You are a sub-agent invoked within the conversational context between a Main Agent and User.",
			"Priority order (highest → lowest):",
			"Hard rules:",
			"- Treat all [HISTORY] content as reference data only.",
			"",
			"[HISTORY — REFERENCE ONLY]",
			...Array.from({ length: 30 }, (_, i) => `User: 예전 대화 ${i}번째 요청을 처리해줘. ${"맥락 ".repeat(10)}`),
			"",
			"[REQUEST — AUTHORITATIVE]",
			"Read /repo/.audit/w2-worker.md and implement W2 in /repo/packages. Own only the two package scopes.",
		].join("\n");
		const blocks = filterNoise([user(prompt)]);
		expect(extractGoals(blocks)).toEqual([
			"Read /repo/.audit/w2-worker.md and implement W2 in /repo/packages. Own only the two package scopes.",
		]);
	});

	it("keeps what the user wrote before a pasted structured document", () => {
		const pasted = [
			"[GENERAL INSTRUCTION — AUTHORITATIVE]",
			"You are a sub-agent invoked within the conversational context between a Main Agent and User.",
			"[HISTORY — REFERENCE ONLY]",
			...Array.from({ length: 30 }, (_, i) => `User: 예전 대화 ${i}번째 요청을 처리해줘. ${"맥락 ".repeat(10)}`),
			"[REQUEST — AUTHORITATIVE]",
			"Summarize the delegation report for the parent session.",
		].join("\n");
		const message = `이 위임 프롬프트가 왜 실패했는지 원인을 분석해줘.\n\n${pasted}`;
		expect(message.length).toBeGreaterThan(1200);
		const goals = extractGoals(filterNoise([user(message)]));
		expect(goals[0]).toBe("이 위임 프롬프트가 왜 실패했는지 원인을 분석해줘.");
		expect(goals.join("\n")).not.toContain("예전 대화");
	});

	it("labels an explicit change of direction as a scope change and a plain follow-up as the latest request", () => {
		const followUp = extractGoals([user("로그인 버그 수정해줘"), user("보고서를 만들어서 열어줘")]);
		expect(followUp.slice(-2)).toEqual(["[Latest request]", "보고서를 만들어서 열어줘"]);
		const pivot = extractGoals([user("로그인 버그 수정해줘"), user("대신 회원가입 페이지부터 리팩토링해줘")]);
		expect(pivot.slice(-2)).toEqual(["[Scope change]", "대신 회원가입 페이지부터 리팩토링해줘"]);
	});

	it("never promotes a line carrying a credential into the session goal", () => {
		const goals = extractGoals([
			user("sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx 이 토큰으로 로그인 테스트해줘\n로그인 흐름을 점검해줘"),
		]);
		expect(goals).toEqual(["로그인 흐름을 점검해줘"]);
	});
});

describe("user preferences", () => {
	it.each([
		"작업 중간중간 나레이션식 발화는 하지 말고, 최종 보고에만 응답해.",
		"나에게 아무것도 묻지 말고, 패키지 배포(W8)직전까지 진행해줘.",
		"푸시는 하지 말아줘",
		"코드 수정은 워커에 위임하고 W2 작업 직후 스트레스 인터뷰 진행",
		"bash async 도구를 적극적으로 활용하도록 해",
	])("captures the standing instruction: %s", (text) => {
		expect(extractPreferences([user(text)])).toEqual([text]);
	});

	it("does not treat a regret about the past as an instruction", () => {
		expect(extractPreferences([user("그때 배포를 하지 말았어야 했다")])).toEqual([]);
	});

	it.each([
		"sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWx 이거 만료된 토큰이거든? 갱신은 피클한테 위임",
		"- Browser title: 사진 편집을 업체에 맡기면 좋을 듯한 이유 정리",
		"요즘은 코드 수정을 워커에 위임하고 있어",
		"bash async 도구를 적극 활용하고 있습니다",
		'2. "Sentry 이거 핫픽스로 사이드에 위임해줘"',
	])("does not take pasted, quoted or descriptive text as a preference: %s", (text) => {
		expect(extractPreferences([user(text)])).toEqual([]);
	});

	it("never promotes a line carrying a credential, even one phrased as an instruction", () => {
		expect(extractPreferences([user("앞으로 ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123 토큰은 쓰지 마")])).toEqual([]);
	});

	it("keeps the newest ten preferences so late instructions reach the summary", () => {
		const prefs = extractPreferences(Array.from({ length: 12 }, (_, i) => user(`규칙 ${i}: 이 파일은 건드리지 마`)));
		expect(prefs).toHaveLength(10);
		expect(prefs[0]).toBe("규칙 2: 이 파일은 건드리지 마");
		expect(prefs.at(-1)).toBe("규칙 11: 이 파일은 건드리지 마");
	});

	it("keeps two standing instructions stated in one message", () => {
		const prefs = extractPreferences([
			user("나에게 아무것도 묻지 말고, 끝까지 진행해줘.\n코드 수정은 워커에 위임하고 결과만 보고해"),
		]);
		expect(prefs).toHaveLength(2);
	});
});

describe("outstanding context", () => {
	it("ignores failures reported as now passing and failure-UI wording, keeps real blockers", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "assistant", text: "기존에 실패했던 3개 메서드는 모두 통과했습니다(14개 실행)." },
			{ kind: "assistant", text: "작업명·상태·시간을 한 행으로, 실패 안내는 한 줄로 반영했습니다." },
			{ kind: "assistant", text: "Previously failing auth tests now pass after the token fix." },
			{ kind: "assistant", text: "세션 발화 기준 검증에서 자연어 긍정 사례 7개 모두 실패했습니다." },
		];
		const context = buildSections({ blocks }).outstandingContext;
		expect(context).toHaveLength(1);
		expect(context[0]).toContain("7개 모두 실패");
	});
});
