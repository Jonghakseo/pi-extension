import { type CommitInfo, extractCommits, formatCommits } from "../extract/commits.ts";
import {
	extractFileActivity,
	type FileActivity,
	type PathDisplayOptions,
	renderFileActivity,
} from "../extract/files.ts";
import { extractGoals } from "../extract/goals.ts";
import { dedupPreferencesAgainstGoals, extractPreferences } from "../extract/preferences.ts";
import type { SectionData } from "../sections.ts";
import type { FileOps, NormalizedBlock } from "../types.ts";
import { buildBriefSections, stringifyBrief } from "./brief.ts";
import { clipSentence, nonEmptyLines } from "./content.ts";
import { builtinRules, type DenoiseRules } from "./rules.ts";
import { collapseSkillLines } from "./skill-collapse.ts";

export interface BuildSectionsInput {
	blocks: NormalizedBlock[];
	briefBlocks?: NormalizedBlock[];
	/** Hook-provided file activity; authoritative for files touched before this compaction. */
	fileOps?: FileOps;
	/** 주입형 디노이즈 규칙 (settings.rules에서 해석). 기본값은 내장 규칙 세트. */
	rules?: DenoiseRules;
	/** Cumulative file activity to render; extracted from `blocks` when omitted. */
	files?: FileActivity;
	/** Cumulative commits to render; extracted from `blocks` when omitted. */
	commits?: CommitInfo[];
	/** How [Files And Changes] shortens paths (session cwd, home). */
	pathDisplay?: PathDisplayOptions;
}

const BLOCKER_RE =
	/\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

// 한국어 장애물 신호. 50세션 샘플링 결과 “실패 시/실패,/실패 N건” 형태의 실제 장애물이
// 접미사 제약(실패했|하|함|합니다)에서 빠져서 bare 실패로 완화했다. 오류/에러는
// 성능 보고(“오류 없음”)에도 쓰여 계속 제외한다.
const BLOCKER_RE_KO =
	/(실패|안\s?돼|안\s?됐|작동 ?(?:을|이)? ?안|동작 ?(?:을|이)? ?안|작동 ?하지 ?않|동작 ?하지 ?않|깨졌|망가졌|막혔|막혀|터졌|크래시|크래쉬|해결 ?(?:이 )?안|고쳐지지|안 ?고쳐|못 ?고쳐|못 ?했|여전히|불가능|차단(?:됐|당))/;

// 문장형 시작 검사: 영어는 대문자, 한국어는 음절 문자. **굵게** 랩도 최대 2개까지 허용한다
// (50세션에서 “**MV3에서는 … 불가능합니다**” 같은 핵심 제약이 굵은 시작으로만 존재했다).
const SENTENCE_START_RE = /^\s*["'`*_]{0,2}(?:[A-Z`]|[\uAC00-\uD7A3])/;

const extractOutstandingContext = (blocks: NormalizedBlock[], rules: DenoiseRules = builtinRules()): string[] => {
	const items: string[] = [];
	const tail = blocks.slice(-20);

	for (const b of tail) {
		if (b.kind === "assistant" || b.kind === "user") {
			// 스킬 본문의 오류 설명은 사용자 장애물이 아니므로 접어서 제외한다.
			for (const rawLine of collapseSkillLines(nonEmptyLines(b.text))) {
				// 번호/불릿 목록 항목도 본문이 문장형이면 받는다. 실제 50세션 샘플링에서
				// “1. MV3에서는 실시간 요청 차단이 불가능합니다” 같은 핵심 제약이 목록
				// 항목으로만 존재해 빠졌다 — 마커를 벗긴 형태로 시작 검사만 완화한다.
				const line = rawLine.replace(/^\s*(?:[-*+>]\s+|\d+[.)]\s+)/, "");
				// URL 경로 속 단어(pilot-failure-claim 등)는 장애물 신호가 아니다
				const checkLine = line.replace(/https?:\/\/\S+/g, " ");
				if (!BLOCKER_RE.test(checkLine) && !BLOCKER_RE_KO.test(checkLine)) continue;
				// 백틱 상태값·인용구 언급·제품명·성공 통계(실패 0)·해소 서사·문서 근거 조각 등
				// 붙여넣은 데이터 오탐 제외는 주입형 규칙(rules.blockerExclusions)으로 관리한다.
				if (rules.blockerExclusions.some((re) => re.test(checkLine))) continue;
				if (line.length < 15) continue;
				// Skip continuation fragments (parentheticals, dangling clauses)
				if (/^\s*\(/.test(line)) continue;
				// Require sentence-like start: capital letter (EN), Hangul syllable (KO), code identifier, or quote.
				// 한국어 혼합 문장(“9/18 두 번과 … 실패”, “npx 캐시의 … 실패”)은 소문자/숫자 시작도,
				// 작업 상태 태그(“[blocked] 버그 재현은 …”)도 허용한다.
				const isSentenceStart =
					SENTENCE_START_RE.test(line) ||
					/^\s*\[[^\]\n]{1,24}\]\s/.test(line) ||
					(/[\uAC00-\uD7A3]/.test(line) && /^[a-z0-9`]/.test(line));
				if (!isSentenceStart) continue;
				const clipped = b.kind === "user" ? `[user] ${clipSentence(rawLine, 150)}` : clipSentence(rawLine, 150);
				if (!items.includes(clipped)) items.push(clipped);
				break;
			}
		}
	}

	return items.slice(0, 5);
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
	const { blocks } = input;
	const rules = input.rules ?? builtinRules();
	const briefSections = buildBriefSections(input.briefBlocks ?? blocks);
	const sessionGoal = extractGoals(blocks, rules);
	const userPreferences = dedupPreferencesAgainstGoals(extractPreferences(blocks, rules), sessionGoal);
	return {
		sessionGoal,
		outstandingContext: extractOutstandingContext(blocks, rules),
		filesAndChanges: renderFileActivity(input.files ?? extractFileActivity(blocks, input.fileOps), input.pathDisplay),
		commits: formatCommits(input.commits ?? extractCommits(blocks)),
		userPreferences,
		briefTranscript: stringifyBrief(briefSections),
	};
};
