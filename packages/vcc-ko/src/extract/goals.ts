import { clipSentence, nonEmptyLines } from "../core/content.ts";
import { builtinRules, type DenoiseRules } from "../core/rules.ts";
import { hasSecretToken } from "../core/secrets.ts";
import { collapseSkillLines, SKILL_MARKER_RE } from "../core/skill-collapse.ts";
import type { NormalizedBlock, SourceRef } from "../types.ts";

const SCOPE_CHANGE_RE =
	/\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;

// 한국어 스크프 변경 신호. \b가 한글에서 동작하지 않아 부분 일치를 허용한다.
// 오탐은 사용자 발화를 [Scope change]로 표시할 뿐이라 피해가 작다.
const SCOPE_CHANGE_RE_KO =
	/(대신|아니[,.! ]|계획(?:이)? ?바뀌|계획 변경|방향 ?전환|방향을 바꿔|그만(?:두고|하고)|무시(?:하고|해도)|잊고|새(?:로운)? ?(?:작업|태스크|요구사항)|바꿔서|옮겨서|전환해서|다시 ?생각해보니|생각해보니|이제(?:는|부터는))/;

const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

// 한국어 단답/인사 노이즈 (ㅇㅇ, 넵, 응, 오케이 등).
const NOISE_SHORT_RE_KO =
	/^(ㅇㅇ|ㅇㅋ|ㅋㅋ|ㄱㄱ|넵|네네|네|응|어|오케이|오케|좋아|좋은데|그래|그래요|고마워|감사(?:합니다|해요|해)|안녕|하이|ㅎㅇ)\s*[.~!?]*$/;

// Signals that the rest of the user message is a command template (e.g. /issues),
// in which case we should stop collecting goals at the signal line.
const TEMPLATE_SIGNAL_RE = /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;

// 한국어 커맨드 템플릿 신호 ("각 이슈에 대해...", "구현하지 말고 분석만...", "출력:" 등).
const TEMPLATE_SIGNAL_RE_KO = /^\s*(각\s+\S+\s+에?대해|구현하지\s*마|분석.{0,20}제안|출력\s*[:：]\s*$)/;

const truncateAtTemplate = (lines: string[]): string[] => {
	const idx = lines.findIndex((l) => TEMPLATE_SIGNAL_RE.test(l) || TEMPLATE_SIGNAL_RE_KO.test(l));
	return idx >= 0 ? lines.slice(0, idx) : lines;
};

const stripLeadingBullet = (line: string): string => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();

const MAX_GOAL_CHARS = 200;
// One line per earlier request keeps the header small; the ref recovers the rest.
const REQUEST_LINE_CHARS = 160;
const EARLIER_REQUESTS = 3;

// URL/파일 경로 토큰. 이스케이프 공백(스크린샷\ 2026…)도 경로의 일부로 벗긴다.
const REF_TOKEN_RE = /^(?:https?:\/\/|file:|\/)(?:[^\s\\]|\\ )+/u;

const hasHangul = (text: string): boolean => /[\uAC00-\uD7A3]/.test(text);

/**
 * A long line that reads like an instruction rather than pasted data: mostly
 * letters, several words, few digits (logs are full of timestamps and counters),
 * almost no code punctuation. Such lines used to be
 * dropped by the 200-char limit, which erased one-line Korean instructions and
 * single-line subagent prompts from [Session Goal] entirely; they are now kept
 * and clipped at a sentence boundary instead.
 */
const looksLikeProse = (t: string): boolean => {
	if (t.split(/\s+/).filter(Boolean).length < 6) return false;
	const letters = (t.match(/\p{L}/gu) ?? []).length;
	const digits = (t.match(/\d/g) ?? []).length;
	const codeSymbols = (t.match(/[{}[\]<>=;|\\`$]/g) ?? []).length;
	return letters / t.length >= 0.5 && digits / t.length < 0.1 && codeSymbols / t.length < 0.03;
};

const withRef = (line: string, ref: SourceRef | undefined): string => (ref == null ? line : `${line} (#${ref})`);

/**
 * 목표 후보 판정. 구조적 검사(길이, 단답, 제어문 코드)는 내장, 제외 패턴은
 * rules.goalExclusions로 주입된다. URL/경로로 시작하는 줄은 참조를 벗긴 본문이
 * 실제 지시(10자 이상)면 목표로 인정한다 — 원본은 이런 줄을 통초로 버려서
 * [Session Goal]이 아예 비는 원인이었다.
 */
const isSubstantiveGoal = (text: string, rules: DenoiseRules): boolean => {
	const t = text.trim();
	if (t.length <= 5) return false;
	if (hasSecretToken(t)) return false;
	if (t.length > MAX_GOAL_CHARS && !looksLikeProse(t)) return false;
	if (NOISE_SHORT_RE.test(t) || NOISE_SHORT_RE_KO.test(t)) return false;
	// 붙여넣은 제어문 코드 줄 걸러내기. 선언문과 달리 제어문(if/for/return)은 원본이
	// 놓쳤다. 한글이 없고 코드 구두점(;,{,=>)이 있는 줄만 거른다 — "return 값이
	// 비어서 나와요" 같은 한국어 지시는 보호된다.
	if (/^\s*(?:if|for|while|switch|return)\b/i.test(t) && !hasHangul(t) && /(?:[;{}]$|=>|\)\s*\{)/.test(t)) return false;
	const excluded = (s: string): boolean => rules.goalExclusions.some((re) => re.test(s));
	if (excluded(t) || REF_TOKEN_RE.test(t)) {
		// URL/경로 시작 줄: 참조만 걷어낸 본문이 지시문이면 받는다. 경로 단독(파일 드롭 등)은
		// 본문이 없으므로 제외된다.
		const stripped = t.replace(REF_TOKEN_RE, "").trim();
		if (stripped.length < 10 || excluded(stripped)) return false;
	}
	return true;
};

// Test scope-change / task intent only on the leading portion of a user block
// so that pasted outputs below the actual instruction do not trigger matches.
const LEADING_CHARS = 200;

interface Directive {
	lines: string[];
	ref?: SourceRef;
	/** Explicit change of direction ("instead", "대신", "계획 변경"), not just the next task. */
	pivot: boolean;
}

export const extractGoals = (blocks: NormalizedBlock[], rules: DenoiseRules = builtinRules()): string[] => {
	const goals: string[] = [];
	const directives: Directive[] = [];

	for (const b of blocks) {
		if (b.kind !== "user") continue;
		// 스킬 본문을 먼저 접는다. 템플릿 신호(For each, 출력: …)가 스킬 매뉴얼 안에 있으면
		// 원래 순서에서는 그 뒤에 붙은 실제 사용자 지시까지 잘려 나갔다.
		const cleaned = collapseSkillLines(nonEmptyLines(b.text));
		// 불릿을 먼저 벗겨야 “- /var/...” 같은 경로/코드 줄이 필터를 통과하는 문제를 막는다.
		// 실제 50세션 샘플링에서 발견: 필터가 불릿 앞에서 돌면 제외 대상이 역으로 통과됐다.
		const lines = truncateAtTemplate(cleaned)
			.map(stripLeadingBullet)
			.filter((l) => isSubstantiveGoal(l, rules))
			.filter((l) => l.length > 5);
		if (lines.length === 0) continue;

		if (goals.length === 0) {
			goals.push(...lines.slice(0, 6).map((l) => clipSentence(l, MAX_GOAL_CHARS)));
			continue;
		}

		// Intent signals are read from what the user wrote, not from an invoked
		// skill's manual (the raw text of a skill invocation starts with <skill ...>).
		const leading = cleaned
			.filter((l) => !SKILL_MARKER_RE.test(l))
			.join("\n")
			.slice(0, LEADING_CHARS);
		// 한국어는 글자당 정보량이 영어보다 높아 동일 임계치면 짧은 실제 작업 지시가 걸러진다
		// (15자 영어 ≈ 8자 한국어). 후속 작업 인지 판단에만 적용한다.
		if (SCOPE_CHANGE_RE.test(leading) || SCOPE_CHANGE_RE_KO.test(leading)) {
			directives.push({ lines: lines.slice(0, 3), ref: b.sourceIndex, pivot: true });
		} else if (rules.taskVerbs.some((re) => re.test(leading)) && lines[0].length > (hasHangul(lines[0]) ? 8 : 15)) {
			directives.push({ lines: lines.slice(0, 2), ref: b.sourceIndex, pivot: false });
		}
	}

	if (directives.length > 0) {
		// The latest directive is the current task. The few before it keep the
		// trajectory visible after many compactions (previously only one survived).
		const earlier = directives.slice(0, -1).slice(-EARLIER_REQUESTS);
		if (earlier.length > 0) {
			goals.push(
				"[Earlier requests]",
				...earlier.map((d) => withRef(clipSentence(d.lines[0], REQUEST_LINE_CHARS), d.ref)),
			);
		}
		const latest = directives[directives.length - 1];
		const latestLines = latest.lines.map((l) => clipSentence(l, MAX_GOAL_CHARS));
		latestLines[latestLines.length - 1] = withRef(latestLines[latestLines.length - 1], latest.ref);
		// "[Scope change]" tells the model the earlier goal is superseded, so it is
		// reserved for explicit pivots; an ordinary follow-up is the latest request.
		goals.push(latest.pivot ? "[Scope change]" : "[Latest request]", ...latestLines);
	}

	return goals;
};
