# pi-vcc-ko

[sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) (MIT)의 포크. 알고리즘형 대화 압축기로, LLM 호출 없이 추출·포맷만으로 브리프 트랜스크립트를 만든다. 한국어 사용자를 위한 추출 정규식 확장이 추가되어 있다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-extension-vcc-ko
```

설치하면 `~/.pi/agent/pi-vcc-ko-config.json`이 기본값으로 생성된다. 이미 파일이 있으면 그대로 쓴다.

## 원본과의 차이

### 한국어 추출 확장 (이 포크의 핵심 변경)

| 모듈 | 확장 내용 |
|------|-----------|
| `src/extract/goals.ts` | `SCOPE_CHANGE_RE_KO` (대신/계획 변경/새 작업/이제는…), `TASK_RE_KO` (수정/구현/추가/조사/찾아/확인/검토/정리…, 완료형 제외), `NOISE_SHORT_RE_KO` (응/넵/ㅇㅋ/오케이…), `TEMPLATE_SIGNAL_RE_KO` (각 ~에 대해/출력:…), 한글 포함 목표 라인의 최소 길이 완화 (15자 → 8자), URL/경로 시작 지시문 목표 인정(이스케이프 공백 경로 포함), 붙여넣은 제어문/헤딩/문서 래퍼 줄 제외, 불릿 벗기 후 필터 적용 |
| `src/extract/preferences.ts` | `PREF_PATTERNS_KO`: 선호한다/하지 마/항상 사용/절대 푸시 마/꼭 확인/스타일:/앞으로. 스킬 본문은 접어서 제외 (한국어 패턴은 스킬 매뉴얼 문장과도 일치하므로) |
| `src/core/build-sections.ts` | `BLOCKER_RE_KO` (실패/안 돼/작동 안 하/깨졌/막혔/여전히/불가능…), `SENTENCE_START_RE`가 한글 음절·굵은 시작을 인정, 혼합 문장(숫자/소문자 시작+한글)·상태 태그(`[blocked]`) 수용, 스킬 본문 접기, URL 경로·인용구·백틱 상태값·제품명·실패 0 통계·해소 서사(수정 후 통과) 제외 |
| `src/core/brief.ts` | `SELF_TALK_PREFIX_RE_KO` (음/아/어/잠깐/그런데…), 한국어 기능어 불용어 추가 |
| `src/core/search-entries.ts` | 한국어 쿼리 노이어 워드 (해줘/알려줘/찾아/관련…) 불용어 추가 |

`Intl.Segmenter`의 한국어 사전 세그멘테이션은 원본 워드 카운팅 그대로 동작함을 확인했다 ("윈도우가"가 한 덤어리로 유지), 별도 가중치는 불필요.

### 세션 서두 사용자 메시지 보존 (포크 개선)

원본은 랭킹 컷(selectRankedBriefBlocks)에서 세션 첫 사용자 메시지가 점수로 밀리면 브리프에서 사라졌고, [Session Goal] 추출마저 실패하면 (URL로 시작하는 지시문, 200자 초과 줄 등) 사용자 의도가 요약에서 통초로 유실됐다. 이 포크는 두 겹의 보호 장치를 둔다:

1. `src/extract/goals.ts` — URL/파일 경로로 시작하는 줄도 참조를 걷어낸 본문이 실제 지시(10자 이상)면 목표로 인정한다. "https://github.com/... 를 포팅해서 ..." 같은 세션 서두가 [Session Goal]에 들어간다.
2. `src/core/rank.ts` — 세션 첫 user 블록은 랭킹 점수와 무관하게 브리프에 남긴다 (문자 예산은 차감).

### 누적 요약·의도 보존 수정 (2026-09-28, 실제 세션 42건 재생으로 검증)

여러 번 컴팩션된 긴 세션에서 요약이 조용히 틀어지던 문제를 고쳤다. 원인 중 두 가지는 업스트림 v0.8.0에도 있다.

| 문제 | 원인 | 수정 |
|------|------|------|
| `[Files And Changes]`가 두 번째 컴팩션부터 2~4개 파일로 고정 (99개 수정 세션이 "3개, 추가 없음"으로 기록) | 요약을 120자로 wrap한 뒤 merge 파서가 `- Modified: ` 첫 줄만 읽음, 오래된 10개 우선 | 파일·커밋을 `details.state`에 구조화해 저장하고 다음 컴팩션이 그걸로 merge (`src/extract/files.ts`, `commits.ts`). 상태가 없는 옛 요약은 wrap-aware로 파싱(`unwrapHeaderLines`). 최근 10개 + `(+N earlier)`, cwd 아래는 상대경로, 홈 아래는 `~/` |
| RECALL_NOTE가 요약마다 2~3개, `---`와 함께 브리프 중간에 누적 | 127자 문구가 wrap되어 `lastIndexOf`로 못 찾음 | 문구를 120자 이내로 줄이고, 현재·레거시 문구를 wrap과 무관하게 전부 제거(`stripRecallNotes`) |
| 커밋 해시 오귀속 (서로 다른 커밋이 같은 해시) | 다음 2블록 안의 아무 16진 문자열이나 해시로 채택 | toolCallId로 자기 결과를 짝짓고, 출력이 커밋을 증명할 때만 기록: git 확인 줄 `[branch hash] msg`, 또는 `commit -q && git log --oneline -1`의 `hash 제목`(제목이 일치할 때). 제목은 git 출력에서 가져온다. 증거 없는 커밋(리다이렉트·압축 출력)은 기록하지 않는다 |
| custom 블록(서브에이전트 결과, 비동기 완료 로그)이 브리프 120줄 중 최대 53줄 차지 | 어시스턴트 산문과 같은 80+120단어 렌더링 | 상태 첫 줄 + 앞 25단어 + 끝 40단어(리뷰 판정 보존), `display:false`는 첫 줄만. `(#cN)` 참조로 원문 복원 가능 |
| 상시 제약("묻지 말고", "코드 수정은 워커에 위임") 유실 | 선호 패턴이 `하지 마`만 인식, 블록당 1개, 가장 오래된 10개 고정 | 일반 부정 명령형(`~지 말고/말아줘/말 것`), 지시 어미가 붙은 위임·적극 활용 지시 추가, 블록당 2개, 최신 10개. 큰따옴표 안 인용 문구와 자격 증명 토큰이 든 줄은 목표·선호로 올리지 않는다 |
| 중간 지시 유실 | Session Goal = 첫 메시지 + 최신 scope change 1건 | `[Earlier requests]`로 직전 요청 3건을 `(#N)` 참조와 함께 보존. 최신 요청은 `[Latest request]`, "대신/계획 변경" 같은 명시적 전환만 `[Scope change]` |
| 서브에이전트 세션 목표가 래퍼 문구·부모 이력으로 채워지거나 비어 있음 | 구획형 프롬프트의 `[REQUEST]`가 맨 끝, 200자 초과 줄 폐기 | 대괄호 대문자 구획 중 첫 구획 앞 서두와 REQUEST만 읽고 REFERENCE 구획은 무시(`structured-prompt.ts`), 산문형 긴 줄은 문장 경계에서 잘라 유지 |

그 밖에 누적 state는 가장 최근 pi-vcc-ko 컴팩션에서 읽고(중간에 다른 컴팩션이 끼어도 유지), 새 브리프가 길어도 이전 브리프 끝 20줄은 남기며(헤더 없는 외부 LLM 요약 포함), `/pi-vcc-ko-recall` 출력은 색인·요약에서 뺀다. 확장 알림은 상태 첫 줄 + 본문 앞 25단어 + 끝 40단어로 남긴다. 스킬 매뉴얼 안의 템플릿 신호가 뒤따르는 사용자 지시를 자르던 문제, 헤더 없는 이전 요약의 브리프가 merge에서 버려지던 문제, `details.sections`에 브리프 헤더·본문이 섞이던 문제, Outstanding Context의 해소 서사 오탐("기존에 실패했던 3개 모두 통과")을 고쳤다. `details.version`은 3이다(v2 전역 `#N` + `#cN` + `state`).

### recall 검색 품질 수정

| 문제 | 수정 |
|------|------|
| `custom_message`(서브에이전트 결과, 비동기 작업 완료)가 검색되지 않음 (실제 세션에서 해당 엔트리에만 있는 문구 84개 중 0개 검색) | 별도 번호 공간 `#cN`으로 색인·검색·펼치기. 기존 `#N`은 그대로라 옛 요약의 참조가 유지된다 (84/84 검색) |
| `role:"system"` 메시지가 `#0 [assistant]` 빈 항목으로 노출 | 번호는 유지한 채 출력에서 제외 (드릴다운은 위치 대신 `#N`으로 조회) |
| `[subagent:worker#41]`이 문자 클래스로 해석돼 전 엔트리에 매치 (검색 대상에 role 이름 포함) | 검색 대상에서 role 제거, 메타문자가 있으면 literal 부분일치 우선, 대괄호 식 하나짜리 쿼리·검색어는 literal |
| 사용자 지시를 골라 찾을 수 없음 | `role` 필터 (`user`/`assistant`/`tool_result`/`bash`/`custom`), 명령은 `role:user` |
| 같은 파일을 여러 번 읽은 결과가 상위를 독점 | 80자 이상 동일 내용은 첫 히트로 접고 `(same content also at #85, #211)` 표시 |
| `/pi-vcc-ko-recall` 페이지 안내가 없는 명령 `/pi-vcc-recall`을 가리킴 | 실제 명령명으로 수정 |

`expand`는 `12`, `"#12"`, `"c3"`을 모두 받고, `query`가 `#134`나 `#c3`처럼 참조뿐이면 펼치기로 처리한다.

### pi 0.87.x 타입 대응

- `SegmentData.isWordLike` 옵셔널 처리 (`src/core/brief.ts`)
- `bashExecution` 역할은 pi-ai `Message` 유니언에 없어 `src/types.ts`의 `asBashExecution` / `isToolCallPart` 타입 가드로 접근 (`normalize.ts`, `render-entries.ts`, `search-entries.ts`, `drill-down.ts`)
- `SessionEntry` 유니언의 `firstKeptEntryId` 접근에 narrow cast (`src/hooks/before-compact.ts`)

### 식별자 분리

- 커맨드: `/pi-vcc-ko`, `/pi-vcc-ko-recall`
- 도구: `session_recall` (기존 `vcc_recall`에서 변경. 원본 pi-vcc와는 압축 처리가 겹치므로 둘 중 하나만 켠다)
- 설정: `~/.pi/agent/pi-vcc-ko-config.json` (`PI_VCC_KO_CONFIG_PATH`로 경로 재정의 가능)
- 디버그 스냅숏: `/tmp/pi-vcc-ko-debug.json`
- compaction `details.compactor`: `"pi-vcc-ko"`

섹션 헤더(`[Session Goal]` 등)와 `session_recall` 도구 설명은 에이전트(LLM) 가독성을 위해 영어를 유지한다.

## 디노이즈 규칙 주입

노이즈 필터링 로직은 `src/core/rules.ts`의 규칙 세트로 분리되어 있다. 내장 규칙이 기본값이며, `pi-vcc-ko-config.json`의 `rules`로 사용처에서 규칙을 추가할 수 있다 (내장 규칙에 덧붙여진다). 그룹별 내장 규칙 전체는 `disableBuiltinRules`로 끌 수 있다.

**내 환경의 세션을 분석해 규칙을 작성하는 방법은 [RULES-GUIDE.md](./RULES-GUIDE.md)를 참고**한다. 분석 스크립트(`tools/analyze-sessions.mjs`)가 프로덕션과 동일한 파이프라인으로 세션을 샘플링해 어떤 규칙이 무엇을 잡았는지 보여준다.

```jsonc
{
  "rules": {
    // 사용자 역할 블록 통초 드롭 (하네스 공지/프로토콜 설명)
    "agentNotices": ["\\b테스트 봇 공지\\b"],
    // 목표 후보 라인 제외
    "goalExclusions": ["^무시하고 넘어가:"],
    // 장애물 후보 라인 제외
    "blockerExclusions": ["회사 전용 대시보드 경고"],
    // 작업 동사 추가 (스코프 변경 추적)
    "taskVerbs": ["배포준비"],
    // 선호 패턴 추가
    "preferencePatterns": ["우리 팀은\\s"]
  },
  "disableBuiltinRules": []
}
```

- 값은 정규식 소스 문자열이며 `i` 플래그로 컴파일된다. 무효 패턴은 제외되고 토스트 경고로 알려준다.
- 내장 규칙은 특정 도구명이 아닌 일반 문형으로 정의한다 (자선언 공지, 후속 메시지 구조 설명, 출력 형식 지시, 첨부 가드레일, 대괄호 컨텍스트 태그 우선순위 문장 등).
- 모듈 API도 규칙을 받는다: `filterNoise(blocks, rules)`, `extractGoals(blocks, rules)`, `extractPreferences(blocks, rules)`, `buildSections({ blocks, rules })`, `compile({ messages, rules })`. 생략 시 내장 규칙.

## 사용법

- `/pi-vcc-ko` — 즉시 압축. `keep:N` (마지막 N턴 유지)과 후속 프롬프트를 지원한다.
- `/pi-vcc-ko-recall <쿼리> [scope:all] [role:user] [page:N]` — 세션 히스토리 검색.
- `session_recall` 도구 — 에이전트가 압축으로 사라진 컨텍스트를 복원할 때 호출.
- `overrideDefaultCompaction` 설정(기본 true) 시 `/compact`·자동 임계치 압축도 이 확장이 처리한다.

자세한 동작(스마트 keep, 토큰 캘리브레이션, 세션 전역 `#N` 인덱스 등)은 원본 README(https://github.com/sting8k/pi-vcc) 참고.

## 테스트

```bash
pnpm vitest run packages/vcc-ko
```

- 업스트림 순수 로직 테스트 포팅: `extract-goals`, `extract-preferences`, `build-sections`, `brief`, `format`, `content`, `recall-scope`, `filter-noise`, `rank` (원본 `fixtures.ts` 포함)
- 한국어 회귀 테스트: `tests/korean-extract.test.ts` (목표/스코프 변경/선호/장애물/불용어/문장 시작/URL 시작 지시문/스킬 본문 제외/코드 줄 제외)
- 요약 누적·의도 보존 회귀 테스트: `summary-merge`, `commits`, `intent-extract`, `compaction-hook` (RECALL_NOTE 1개 유지, wrap된 레거시 파일 목록 복원, 구조화 상태 누적, 커밋 해시 짝짓기, 구획형 프롬프트, 부정 명령형 선호, custom `#cN` 참조)
- recall 회귀 테스트: `recall-entries`, `recall-search`, `recall-tool`, `recall-command` (custom 색인, system 제외, literal 우선, role 필터, 중복 접기, 참조 펼치기)
- 실제 세션 재생 검증(2026-09-28): 컴팩션 42건을 현재 코드로 연쇄 재생해 RECALL_NOTE 요약당 1개(수정 전 25건이 2~3개), `(#N)`/`(#cN)` 참조 1,553건 정합, 요약에 적힌 커밋 35건의 해시·제목이 실제 git 이력과 일치, 파일 누적 `최근 10개 (+N earlier)` 확인
- 실제 로컬 세션 50개 정량 검증 (독립 휴리스틱 라벨러로 TP/FN/FP 측정, Wilson 95% CI): 첫 블록 목표 32/32·FP 0, 최종 의도 추적 8/8·FP 0, 선호 2/2, 장애물 24/27·FP 3, 브리프 유의미 턴 120/120·노이즈 FP 0. 여기서 발견해 수정한 것: TASK_RE_KO 동사 누락(찾아/확인/검토/정리), 불릿-필터 순서 버그, 이스케이프 공백 경로 오탐, Picky 부트스트랩/문서 래퍼 유입, 번호 목록 핵심 제약 누락, URL 경로·인용구·백틱 상태값·해소 서사 오탐
