import { describe, expect, it } from "vitest";
import { buildSections } from "../src/core/build-sections.ts";
import { extractGoals } from "../src/extract/goals.ts";
import { dedupPreferencesAgainstGoals, extractPreferences } from "../src/extract/preferences.ts";
import type { NormalizedBlock } from "../src/types.ts";

describe("한국어 목표 추출 (extractGoals)", () => {
	it("첫 사용자 메시지의 한국어 라인을 목표로 추출한다", () => {
		const blocks: NormalizedBlock[] = [{ kind: "user", text: "로그인 버그 수정해줘\n인증 플로우도 확인해줘" }];
		const goals = extractGoals(blocks);
		expect(goals).toContain("로그인 버그 수정해줘");
		expect(goals).toContain("인증 플로우도 확인해줘");
	});

	it("한국어 단답(응, 넵, ㅇㅇ)은 목표에서 제외한다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "응" },
			{ kind: "user", text: "넵" },
			{ kind: "user", text: "ㅇㅋ" },
			{ kind: "assistant", text: "네" },
			{ kind: "user", text: "세션 토큰 리프레시 로직도 수정해줘" },
		];
		const goals = extractGoals(blocks);
		expect(goals[0]).toContain("세션 토큰");
		expect(goals.some((g) => ["응", "넵", "ㅇㅋ"].includes(g))).toBe(false);
	});

	it("한국어 스코프 변경 신호(대신, 계획 변경)를 [Scope change]로 잡는다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "로그인 버그 수정해줘" },
			{ kind: "assistant", text: "확인했습니다" },
			{ kind: "user", text: "대신 회원가입 페이지 리팩토링부터 해줘" },
		];
		const goals = extractGoals(blocks);
		expect(goals).toContain("[Scope change]");
		expect(goals.some((g) => g.includes("회원가입"))).toBe(true);
	});

	it("짧은 한국어 작업 지시(8자 이상)도 최신 요청으로 인식한다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "로그인 버그 수정해줘" },
			{ kind: "assistant", text: "완료했습니다" },
			{ kind: "user", text: "테스트 케이스 추가" },
		];
		const goals = extractGoals(blocks);
		expect(goals).toContain("[Latest request]");
		expect(goals.some((g) => g.includes("테스트"))).toBe(true);
	});

	// 50세션 샘플링에서 발견: 후속 지시 동사(찾아/확인/검토/정리)가 TASK_RE_KO에 없어
	// 최종 사용자 의도가 스코프 변경으로 추적되지 않았다. 완료형(확인했어요)은 제외한다.
	it("후속 지시 동사(정리/확인)를 최신 요청으로 추적한다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "리펙토링 작업 시작했어" },
			{ kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
			{ kind: "user", text: "오키 임시 워크트리 정리해" },
			{ kind: "user", text: "지금 세션 모델이 뭔지 확인해봐" },
		];
		const goals = extractGoals(blocks);
		const scopeIdx = goals.indexOf("[Latest request]");
		expect(scopeIdx).toBeGreaterThan(-1);
		const scope = goals.slice(scopeIdx + 1).join("\n");
		expect(scope).toContain("확인해봐");
	});

	it("명령형 일반형(해줘)도 후속 지시로 추적한다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "리팩토링 작업 시작했어" },
			{ kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
			{ kind: "user", text: "짧게 흐름을 요약해줘." },
		];
		const goals = extractGoals(blocks);
		const scopeIdx = goals.indexOf("[Latest request]");
		expect(scopeIdx).toBeGreaterThan(-1);
		expect(goals.slice(scopeIdx + 1).join("\n")).toContain("요약해줘");
	});

	it("완료형 보고(확인했어요)는 후속 요청으로 추적하지 않는다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "리펙토링 작업 시작했어" },
			{ kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
			{ kind: "user", text: "확인했어요. 잘 되네요." },
		];
		const goals = extractGoals(blocks);
		expect(goals.includes("[Scope change]")).toBe(false);
		expect(goals.includes("[Latest request]")).toBe(false);
	});

	it("한국어 커맨드 템플릿 신호에서 목표 수집을 중단한다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "이슈 목록 정리해줘\n각 이슈에 대해 상세 분석을 먼저 진행한다\n- 1번 이슈 확인" },
		];
		const goals = extractGoals(blocks);
		expect(goals).toContain("이슈 목록 정리해줘");
		expect(goals.some((g) => g.includes("1번 이슈"))).toBe(false);
	});

	// 실제 유실 사례 회귀: 사용자의 첫 메시지가 URL로 시작하면 원본 NON_GOAL_RE가 줄을
	// 통초로 버려서 [Session Goal]이 비고 사용자 의도가 요약에서 사라졌다.
	it("URL로 시작하는 한국어 지시문을 목표로 인정한다", () => {
		const blocks: NormalizedBlock[] = [
			{
				kind: "user",
				text: "https://github.com/sting8k/pi-vcc 를 포팅해서 나만의 익스텐션으로 만들고 싶어. pi-vcc의 구현들을 다 가져오되, 에이전트 스코프 및 유저 지침 정규식 등에서 영어 사용자에 맞춰져 있는 부분을 한국어 사용자에게도 확장하고 싶어.",
			},
		];
		const goals = extractGoals(blocks);
		expect(goals.length).toBeGreaterThan(0);
		expect(goals[0]).toContain("를 포팅해서");
		expect(goals[0]).toContain("한국어 사용자에게도 확장");
	});

	it("본문 없는 순수 URL/경로 줄은 여전히 목표에서 제외한다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "https://github.com/sting8k/pi-vcc" },
			{ kind: "user", text: "/Users/example/.pi/agent/extensions" },
		];
		expect(extractGoals(blocks)).toEqual([]);
	});

	// 실제 세션(product 09-14)에서 발견: 붙여넣은 제어문 코드가 목표에 샜다.
	it("붙여넣은 제어문 코드 줄은 목표에서 제외하고 한국어 지시는 보존한다", () => {
		const blocks: NormalizedBlock[] = [
			{
				kind: "user",
				text: "우선순위 정렬 유틸을 만들어줘\nif (!items.every((item) => typeof item.priority === 'number')) {\nreturn [...items].sort((left, right) => left.priority - right.priority);\nfor (const item of items) {\nconsole.log(item);\n}",
			},
		];
		const goals = extractGoals(blocks);
		expect(goals[0]).toContain("우선순위 정렬 유틸");
		expect(goals.some((g) => g.startsWith("if ("))).toBe(false);
		expect(goals.some((g) => g.startsWith("return [...items]"))).toBe(false);
		expect(goals.some((g) => g.startsWith("for (const"))).toBe(false);
	});

	it("한국어 지시가 제어문 키워드로 시작해도 목표로 보존한다", () => {
		const blocks: NormalizedBlock[] = [{ kind: "user", text: "return 값이 비어서 나와요. 조건 분기 수정해줘" }];
		expect(extractGoals(blocks)[0]).toContain("조건 분기 수정해줘");
	});

	// 50세션 샘플링에서 발견: 이스케이프 공백(스크린샷\ 2026…)이 포함된 경로만 있는
	// 메시지가 유니코드 파일명 꼬리를 본문으로 오판해 목표로 샜다.
	it("경로만 있는 메시지(이스케이프 공백 포함)는 목표에서 제외한다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "/var/folders/xx/스크린샷\\ 2026-09-20\\ 오후\\ 10.30.04.png" },
		];
		expect(extractGoals(blocks)).toEqual([]);
	});

	// Picky/문서 래퍼 줄은 목표가 아니다.
	// 하네스/에이전트 메타 지시 줄은 사용자 목표가 아니다. 도구명이 아닌 일반 문형으로 판정한다.
	it("모델 메타 지시 줄(출력 형식, 첨부 가드레일, 에이전트 자기서술)은 목표에서 제외한다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "2) [REQUEST — AUTHORITATIVE] below" },
			{ kind: "user", text: "Return a concise final summary for the user." },
			{ kind: "user", text: "Return a clear final answer for Picky and the user." },
			{ kind: "user", text: "If terminal output is provided, inspect all of it before answering." },
			{ kind: "user", text: "You are a sub-agent invoked within a larger session." },
			{
				kind: "user",
				text: "If [REQUEST — AUTHORITATIVE] conflicts with [HISTORY], follow [REQUEST — AUTHORITATIVE].",
			},
		];
		expect(extractGoals(blocks)).toEqual([]);
	});

	it("같은 문형이라도 실제 지시문은 목표로 남는다", () => {
		const blocks: NormalizedBlock[] = [
			{
				kind: "user",
				text: "If the build fails, fix it and run the full test suite.\nRespond to the user's bug report with a fix plan and implement it.",
			},
		];
		const goals = extractGoals(blocks);
		expect(goals).toHaveLength(2);
		expect(goals[0]).toContain("If the build fails");
		expect(goals[1]).toContain("fix plan");
	});
});

describe("한국어 선호 추출 (extractPreferences)", () => {
	it("'선호' 표현을 선호로 인식한다", () => {
		const blocks: NormalizedBlock[] = [{ kind: "user", text: "pnpm을 선호합니다" }];
		expect(extractPreferences(blocks)).toHaveLength(1);
	});

	// 실제 세션(pi-agent 09-22)에서 발견: 스킬 본문의 매뉴얼 문장이 선호로 샜다.
	it("스킬 본문은 선호로 추출하지 않는다", () => {
		const skillBlock: NormalizedBlock = {
			kind: "user",
			text: '<skill name="pi-auto-update">\n목표는 8단계를 수행하는 것이다.\nnpm 로그인을 반드시 먼저 실행한다.\n</skill>',
		};
		expect(extractPreferences([skillBlock])).toEqual([]);
	});

	it("'항상/절대' 지시를 선호로 인식한다", () => {
		const blocks: NormalizedBlock[] = [{ kind: "user", text: "항상 테스트를 먼저 실행해줘" }];
		const blocks2: NormalizedBlock[] = [{ kind: "user", text: "절대 main 브랜치에 직접 푸시하지 마" }];
		expect(extractPreferences(blocks)).toHaveLength(1);
		expect(extractPreferences(blocks2)).toHaveLength(1);
	});

	it("'앞으로' 지시를 선호로 인식한다", () => {
		const blocks: NormalizedBlock[] = [{ kind: "user", text: "앞으로 커밋 메시지는 한국어로 작성해줘" }];
		expect(extractPreferences(blocks)).toHaveLength(1);
	});

	it("한국어 질문은 선호에서 제외한다", () => {
		const blocks: NormalizedBlock[] = [{ kind: "user", text: "이걸 선호하는 이유가 뭐야?" }];
		expect(extractPreferences(blocks)).toHaveLength(0);
	});

	it("한국어 선호와 목표가 겹치면 중복을 제거한다", () => {
		const goals = ["항상 테스트를 먼저 실행해줘"];
		const prefs = dedupPreferencesAgainstGoals(["항상 테스트를 먼저 실행해줘"], goals);
		expect(prefs).toHaveLength(0);
	});
});

describe("한국어 outstanding context (buildSections)", () => {
	it("한국어 장애물 문장을 Outstanding Context에 넣는다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "assistant", text: "여전히 lint 검사가 실패합니다. 42행을 다시 확인해야 합니다." },
		];
		const r = buildSections({ blocks });
		expect(r.outstandingContext.length).toBeGreaterThan(0);
	});

	it("한국어 사용자 보고도 outstanding context로 잡는다", () => {
		const blocks: NormalizedBlock[] = [{ kind: "user", text: "테스트가 계속 실패하는데 원인을 못 찾겠어요" }];
		const r = buildSections({ blocks });
		expect(r.outstandingContext.length).toBeGreaterThan(0);
		expect(r.outstandingContext.some((o) => o.includes("[user]"))).toBe(true);
	});

	// 스킬 본문의 오류 설명은 사용자 장애물이 아니다 (선호와 동일 취급).
	it("스킬 본문의 오류 문장은 outstanding context에서 제외한다", () => {
		const skillBlock: NormalizedBlock = {
			kind: "user",
			text: '<skill name="x">\n빌드가 실패하면 다음 단계를 중단한다.\n</skill>',
		};
		const r = buildSections({ blocks: [skillBlock] });
		expect(r.outstandingContext).toEqual([]);
	});

	// 50세션 샘플링에서 발견한 오탐/누락 세트.
	it("URL 경로 속 failure와 실패 0 통계는 장애물이 아니다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "assistant", text: "참고: https://example.com/the-mit-genai-pilot-failure-claim/ 를 읽어봤습니다." },
			{ kind: "assistant", text: "업로드 완료 (성공 6, 실패 0). 서버 최종 상태를 재조회해 검증할게요." },
		];
		const r = buildSections({ blocks });
		expect(r.outstandingContext).toEqual([]);
	});

	it("완료 보고(실패했고 수정 후 통과)는 outstanding에서 제외한다", () => {
		const blocks: NormalizedBlock[] = [
			{
				kind: "assistant",
				text: "수정 전에는 8개 중 6개가 실제 Next의 undefined 직렬화 오류로 실패했고, 수정 후 관련 SSR 테스트 15개가 통과했습니다.",
			},
		];
		const r = buildSections({ blocks });
		expect(r.outstandingContext).toEqual([]);
	});

	it("혼합 문장(숫자/소문자 시작+한글) 장애물과 상태 태그를 수용한다", () => {
		const blocks: NormalizedBlock[] = [
			{
				kind: "assistant",
				text: "9/18 두 번과 오늘 재트리거 실패: 세션이 스크립트를 백그라운드로 띄운 뒤 즉시 종료했습니다.",
			},
			{
				kind: "assistant",
				text: "[blocked] 버그 재현은 완료했지만 테스트 하니스 수정 중 재시도 한도에 도달해 자체 변경을 원복했습니다.",
			},
		];
		const r = buildSections({ blocks });
		expect(r.outstandingContext.length).toBe(2);
		expect(r.outstandingContext.some((o) => o.includes("재트리거 실패"))).toBe(true);
		expect(r.outstandingContext.some((o) => o.includes("[blocked]"))).toBe(true);
	});

	// 50세션 샘플링 결과: “1. MV3에서는 … 불가능합니다”처럼 핵심 제약이 목록 항목으로만
	// 존재하는 사례가 많아, 불릿/번호 문장은 수용하고 짧은 조각·괄호만 제외한다.
	it("짧은 조각과 괄호 조각은 제외하고 목록 항목 문장은 받는다", () => {
		const blocks: NormalizedBlock[] = [
			{
				kind: "assistant",
				text: "진행 상황:\n- 깨짐\n(괄호로 시작하는 조각)\n1. MV3에서는 실시간 요청 차단이 불가능합니다.",
			},
		];
		const r = buildSections({ blocks });
		expect(r.outstandingContext.some((o) => o.includes("불가능합니다"))).toBe(true);
		expect(r.outstandingContext.some((o) => o.includes("괄호로 시작"))).toBe(false);
	});

	it("한국어 브리프 전사가 한국어를 유지한다", () => {
		const blocks: NormalizedBlock[] = [
			{ kind: "user", text: "인증 토큰 리프레시 로직 수정해줘" },
			{ kind: "tool_call", name: "Read", args: { file_path: "session.ts" } },
			{ kind: "assistant", text: "원인은 패스워드 리셋 후 토큰 갱신 누락입니다" },
		];
		const r = buildSections({ blocks });
		expect(r.briefTranscript).toContain("인증 토큰 리프레시");
		expect(r.briefTranscript).toContain("[user]");
		expect(r.briefTranscript).toContain('* Read "session.ts"');
		expect(r.sessionGoal).toContain("인증 토큰 리프레시 로직 수정해줘");
	});
});

describe("한국어 브리프 처리 (brief)", () => {
	it("한국어 자기언급 접두어(음, 근데, 잠깐)를 제거한다", async () => {
		const { compileBrief } = await import("../src/core/brief.ts");
		const out = compileBrief([{ kind: "assistant", text: "근데 원인은 캐시 무효화 누락이었습니다", sourceIndex: 0 }]);
		expect(out).toContain("[assistant]");
		expect(out).not.toContain("근데");
		expect(out).toContain("캐시 무효화");
	});

	it("한국어 텍스트가 단어 단위로 과도하게 잘리지 않는다", async () => {
		const { compileBrief } = await import("../src/core/brief.ts");
		const longKo = "세션 관리자는 컨텍스트 윈도우를 추적하고 압축 임계치에 도달하면 요약을 생성합니다. ";
		const out = compileBrief([{ kind: "user", text: longKo.repeat(30), sourceIndex: 0 }]);
		// 잘렸다면 컨텐츠 앞머리는 유지되어야 하고, 한국어 단어가 통째로 보존된다
		expect(out).toContain("세션 관리자는");
	});
});

describe("하네스 공지 일반 규칙 (filterNoise)", () => {
	it("자선언 공지와 프로토콜 설명 블록을 노이즈로 드롭한다", async () => {
		const { filterNoise } = await import("../src/core/filter-noise.ts");
		const blocks: NormalizedBlock[] = [
			{
				kind: "user",
				text: "This message was not sent by the user. It is a one-time bootstrap notice injected by an agent daemon.",
			},
			{ kind: "user", text: "Subsequent turn markers will only carry each request and captured context." },
			{ kind: "user", text: "로그인 버그 고쳐줘" },
		];
		const out = filterNoise(blocks);
		expect(out).toHaveLength(1);
		expect(out[0].kind === "user" && out[0].text).toContain("로그인 버그");
	});
});
