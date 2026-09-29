/**
 * Pi VCC KO Extension
 *
 * sting8k/pi-vcc (MIT)의 알고리즘형 대화 압축기 포크. 한국어 사용자를 위해
 * 목표/선호/장애물 추출 정규식을 확장했다:
 *
 *   - SCOPE_CHANGE_RE_KO / TASK_RE_KO  — 한국어 스크프 변경·작업 지시 신호
 *   - NOISE_SHORT_RE_KO                — 한국어 단답(응/넵/ㅇㅋ) 노이즈 필터
 *   - BLOCKER_RE_KO                    — 한국어 Outstanding Context 신호
 *   - SENTENCE_START_RE                — 한글 음절을 문장형 시작으로 인정
 *   - PREF_PATTERNS_KO                 — 한국어 선호(선호/항상/절대/앞으로) 패턴
 *   - SELF_TALK_PREFIX_RE_KO / 한국어 불용어 — 브리프·검색 품질
 *
 * 커맨드/설정은 독립 식별자를 쓴다: /pi-vcc-ko, /pi-vcc-ko-recall,
 * vcc_recall 도구, ~/.pi/agent/pi-vcc-ko-config.json.
 *
 * 업스트림과의 차이: pi 0.87.x 타입 대응(isWordLike 옵셔널, bashExecution
 * 타입 가드), 설정 파일 경로·compactor 식별자 분리.
 *
 * 커맨드:
 *   /pi-vcc-ko            — 즉시 압축 (keep:N, 후속 프롬프트 지원)
 *   /pi-vcc-ko-recall     — 세션 히스토리 검색 (scope:all, page:N)
 *   도구: vcc_recall      — 에이전트가 컨텍스트 복원용으로 호출
 *
 * 기본 동작: overrideDefaultCompaction=true면 /compact·자동 임계치 압축도
 * 이 확장이 처리한다. 설정은 ~/.pi/agent/pi-vcc-ko-config.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiVccCommand } from "./src/commands/pi-vcc.ts";
import { registerVccRecallCommand } from "./src/commands/vcc-recall.ts";
import { scaffoldSettings } from "./src/core/settings.ts";
import { registerBeforeCompactHook } from "./src/hooks/before-compact.ts";
import { registerRecallTool } from "./src/tools/recall.ts";

export default (pi: ExtensionAPI) => {
	scaffoldSettings();
	registerBeforeCompactHook(pi);
	registerPiVccCommand(pi);
	registerVccRecallCommand(pi);
	registerRecallTool(pi);
};
