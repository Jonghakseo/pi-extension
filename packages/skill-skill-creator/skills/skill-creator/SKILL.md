---
name: skill-creator
description: "Pi 스킬을 새로 만들거나 수정·검증할 때 사용한다."
license: MIT
compatibility: 검증 스크립트 `scripts/validate_skill.py`는 python3가 필요하다(표준 라이브러리만 사용, PyYAML이 있으면 함께 쓴다). python3가 없으면 검증은 건너뛰고 `references/pi-skill-checklist.md`로 수동 점검한다. Pi 공식 문서를 읽는 단계는 pi CLI가 설치돼 있어야 한다.
---

# skill-creator

Pi 환경에서 Agent Skills 표준을 따르는 스킬을 만들고, 작게 검증하고, 피드백으로 개선한다.

검증 스크립트는 `python3`가 필요하다. `python3 --version`이 실패하면 [references/setup.md](references/setup.md)의 최초 설정을 사용자에게 안내한다.

## 핵심 원칙

- **Pi 우선**: Claude Code 전용 명령, `claude -p`, Anthropic eval viewer 스크립트를 전제로 하지 않는다. Pi CLI, `read`/`write`/`edit`/`bash`, 필요 시 `subagent`, `ask_user_question`, `todo_write`를 사용한다.
- **표준 준수, Pi 동작 우선**: `SKILL.md`는 Agent Skills 표준의 YAML frontmatter + Markdown 본문을 따른다. 단 Pi는 표준 일부를 의도적으로 완화한다(아래 "Pi vs 표준" 참고). 충돌 시 Pi 동작을 따른다.
- **Progressive disclosure**: 항상 들어가는 `description`은 정확하고 트리거 친화적으로, 본문은 500줄 미만을 목표로, 긴 자료는 `references/`, 반복 가능한 작업은 `scripts/`, 템플릿은 `assets/`에 둔다.
- **실행 목적에 집중**: 본문과 런타임 참조에는 해당 작업의 목표 달성에 필요한 정보만 둔다. 제작 출처·작성 배경·수정 이력은 넣지 않는다. 명령·제약을 이해하는 데 필요한 외부 문서와 다른 스킬로의 연계·트리거는 유지한다.
- **검증 가능한 산출물**: 스킬이 수행하는 작업의 결과를 확인할 기준을 담는다. 스킬 자체의 구조·트리거 평가용 자료는 실행 본문과 분리하고, 평가할 때만 읽는다.
- **놀라움 금지**: 사용자가 기대하지 않은 권한 상승, 데이터 유출, 위험한 자동화, 악성 행위 보조 스킬은 만들지 않는다.

### Pi vs 표준 (자주 헷갈리는 지점)

- 이름과 디렉터리명이 달라도 Pi는 **경고조차 내지 않는다**(표준은 일치 요구). 여러 하네스가 공유하는 스킬 디렉터리에서는 일부러 다르게 두는 것이 합리적일 수 있다.
- `name`을 아예 빼면 Pi는 부모 디렉터리명으로 대체한다. 그래도 표준은 필수 필드이므로 적는다.
- `description`이 없거나 비어 있으면 Pi는 스킬을 **아예 로딩하지 않는다**. 다른 위반(이름 글자 규칙, description 1024자 초과)은 warning만 내고 로딩은 된다.
- 같은 이름 스킬이 여러 위치에 있으면 **먼저 발견된 것만** 사용되고 나머지는 warning이 뜬다.
- `allowed-tools`는 표준에만 있는 필드다. Pi는 읽지 않는다.

## 언제 어떤 작업을 하나

```
사용자가 스킬을 만들고 싶다
  ├─ 의도/트리거/출력 형식이 충분히 명확함 → 초안 작성
  ├─ 일부만 명확함 → 대화 기록에서 추출 후 빈칸만 질문
  └─ 모호함 → ask_user_question으로 목적, 트리거, 산출물, 평가 필요 여부를 한 번에 확인

사용자가 기존 스킬을 고치고 싶다
  ├─ 경로 제공됨 → 해당 SKILL.md와 주변 resources 읽기
  └─ 경로 없음 → 후보 검색 후 확인

사용자가 스킬 성능/트리거를 개선하고 싶다
  ├─ 현재 description 분석
  ├─ should-trigger / should-not-trigger 쿼리 작성
  └─ 필요하면 Pi CLI 또는 subagent로 소규모 eval 실행
```

## Workflow

### 1. 컨텍스트 수집

1. 관련 공식 문서를 확인한다. 설치된 pi 실행 파일에서 패키지 루트를 구한다. `npm root -g`는 다른 런타임의 경로를 뱉을 수 있으므로 쓰지 않는다.

   ```bash
   PI_ROOT="$(cd "$(dirname "$(realpath "$(which pi)")")/../.." && pwd)"
   cat "$PI_ROOT/docs/skills.md"          # Pi 스킬 문서
   cat "$PI_ROOT/docs/usage.md"           # 필요 시 Pi 사용법
   ```

   - Agent Skills 표준: <https://agentskills.io/specification>
2. 기존 스킬 패턴이 필요하면 `~/.pi/agent/skills/`, `~/.agents/skills/`, 프로젝트의 `.pi/skills/`, `.agents/skills/`를 살펴본다.
3. 사용자의 현재 대화에서 다음을 먼저 추출한다.
   - 스킬이 가능하게 해야 하는 일
   - 트리거되어야 하는 표현/상황
   - 기대 산출물 형식
   - 필요한 도구/의존성/권한
   - 테스트 또는 eval이 필요한지
4. 빈칸이 많으면 `ask_user_question`으로 한 번에 묻는다. 단, 이미 충분히 명확하면 묻지 말고 진행한다.

### 2. 위치와 이름 결정

로딩 위치(Pi가 자동 스캔):

- 전역(Pi 전용): `~/.pi/agent/skills/`
- 전역(cross-harness 공유): `~/.agents/skills/`
- 프로젝트(Pi 전용): `<repo>/.pi/skills/`
- 프로젝트(cross-harness): `<repo>/.agents/skills/` — cwd부터 git 루트(또는 fs 루트)까지 상향 탐색
- 패키지: `package.json`의 `pi.skills` 또는 패키지 내 `skills/`
- 설정/명령행: `.pi/settings.json`의 `"skills"` 배열, `pi --skill <path>`(반복 가능, `--no-skills`와도 합산)

탐색 디테일:

- `~/.pi/agent/skills/`, `.pi/skills/`에서는 루트의 단일 `.md` 파일도 스킬로 인식된다(디렉터리 없이 한 파일짜리 스킬 가능).
- `~/.agents/skills/`, `.agents/skills/`에서는 루트의 `.md`는 무시되지만, **하위 디렉터리의 모든 `.md`** 가 스킬로 로딩된다(`SKILL.md`가 아니어도 된다). 메모 파일을 이 아래에 두면 의도치 않게 스킬이 되므로 `.ignore`로 제외하거나 다른 곳에 둔다.
- 동일 이름이 여러 위치에 있으면 first-found wins. 충돌 시 워닝이 뜨므로 신규 스킬 이름은 미리 `rg --files -g 'SKILL.md' ~/.pi/agent/skills ~/.agents/skills .pi/skills .agents/skills 2>/dev/null` 정도로 확인.

다른 하네스(Claude Code, Codex)의 스킬을 가져와 쓰려면 `.pi/settings.json`(또는 `~/.pi/settings.json`)에 추가:

```json
{ "skills": ["~/.claude/skills", "~/.codex/skills"] }
```

이름 규칙(Pi 적용분):

- 1~64자, 소문자 영문/숫자/하이픈만 사용한다.
- 앞뒤 하이픈, 연속 하이픈은 금지한다.
- 디렉터리명과 `name`을 동일하게 두는 것을 **권장**한다(Agent Skills 표준 요구). 단 Pi는 강제하지 않으므로, cross-harness 공유 디렉터리에서 의도적으로 다르게 두어도 로딩된다.
- 예: `ship`, `systematic-debugging`, `airtable-reporting`

### 3. 설계 초안

복잡한 스킬이면 작성 전에 짧게 설계를 보여준다.

```markdown
스킬 설계안:
- 이름/위치: ...
- 트리거: ...
- 핵심 workflow: ...
- resources: scripts/... references/... assets/...
- 검증 방법: ...
```

간단한 스킬이면 설계 문단을 내부 체크리스트로 처리하고 바로 초안을 작성해도 된다.

### 4. SKILL.md 작성 패턴

프론트매터(최소):

```yaml
---
name: my-skill
description: 어떤 목적으로 어떤 상황에서 호출되는지 1~2문장으로 쓴다.
---
```

표준이 정의하는 선택 필드:

| 필드 | 용도 | Pi 동작 |
|---|---|---|
| `license` | 라이선스 이름 또는 번들된 파일 참조 | 보존만 함 |
| `compatibility` | 환경 요구사항(표준 상한 500자) | 보존만 함, 길이 검사 없음 |
| `metadata` | 자유 key-value | 보존만 함 |
| `allowed-tools` | 공백 구분 사전 승인 툴 목록(experimental) | **읽지 않음** |
| `disable-model-invocation` | `true`면 시스템 프롬프트에서 숨김 | 적용됨. **자동 트리거 금지, `/skill:name`으로만 호출 가능** |

프론트매터는 전체 YAML로 파싱된다. 블록 스칼라(`description: >`)와 중첩 매핑(`metadata:`)도 의도대로 읽히지만, `description`은 한 줄로 두는 쪽이 읽기 쉽다.

자동 트리거가 위험하거나 사용자 명시 호출만 허용해야 하는 스킬(파괴적 동작, 외부 전송, 비용 큰 작업)은 `disable-model-invocation: true`로 두는 것을 검토한다.

`argument-hint` 같은 Claude Code 전용 필드는 Pi가 인식하지 않으므로 넣지 않는다. 알려지지 않은 필드는 Pi가 조용히 무시한다.

본문 권장 구조:

```markdown
# my-skill

한 문단 요약.

## 핵심 원칙
- 왜 이 절차가 중요한지 설명한다.

## Workflow
### 1. ...
### 2. ...

## Tool guidance
- 어떤 상황에서 어떤 Pi 도구를 쓸지 적는다.

## Output format
사용자가 기대하는 최종 응답/파일 형식을 명시한다.

## Validation
작업의 실제 결과를 확인할 명령과 완료 기준을 적는다. 스킬 자체를 평가하는 명령·프롬프트는 넣지 않는다.

## Edge cases
흔한 실패/예외와 대응을 적는다.
```

작성 팁:

- `description`에는 "무엇"과 "언제"를 모두 넣는다. 자동 트리거는 이 필드에 크게 의존한다. **빠지면 Pi는 스킬 자체를 로딩하지 않는다.**
- `description`은 목적과 호출 상황만 1~2문장(약 150자 이내)으로 간결하게 쓴다. 구현 방식, 트리거 예시 문구 나열, 쓰지 말아야 할 상황, 세부 옵션은 사족이므로 본문에 둔다.
  - 좋음: `플로우차트·아키텍처도·개념도 같은 다이어그램을 그려 달라는 요청에 사용한다.`
  - 나쁨: `... 요청에 사용한다. .excalidraw 파일을 만들고 로컬 창으로 연다. 기존 파일 수정에도 사용한다. Mermaid 요청에는 사용하지 않는다.`
- 모델이 따라야 하는 행동은 명령형으로 쓰되, 무조건적인 MUST 남발보다 이유를 설명한다.
- 대형 레퍼런스는 본문에 붙이지 말고 `references/`로 분리한 뒤 언제 읽어야 하는지 명시한다.
- 반복적·결정적 검증은 `scripts/`로 옮겨 매번 재발명하지 않게 한다.
- 상대 경로는 스킬 루트 기준으로 쓴다. 예: `references/pi-skill-checklist.md`, `scripts/validate_skill.py`. 절대경로(`/Users/...`)는 다른 사용자/머신에서 깨지므로 피한다.

### `/skill:name` 강제 호출

Pi에서 사용자는 `/skill:<name>` 슬래시 명령으로 스킬을 명시 호출할 수 있다. 명령 뒤 인자는 접두사 없이 스킬 본문 블록 뒤에 평문 그대로 append된다.

```text
/skill:my-skill input.pdf --pages 1-3
```

- 트리거 description이 약하거나 모호한 도메인이면 본문에 "확실하지 않으면 `/skill:<name>`으로 호출하세요" 같은 안내를 둔다.
- `disable-model-invocation: true`인 스킬은 이 경로로만 호출된다.
- 설정의 `enableSkillCommands: false`는 명령 자동완성 목록에서만 스킬을 숨긴다. 직접 입력한 `/skill:name`은 그대로 동작하므로 자동 호출을 막는 수단이 아니다. 그 용도에는 `disable-model-invocation: true`를 쓴다.

### 5. Pi 친화적 평가 루프

사용자가 평가를 원하거나 객관 결과가 중요한 스킬이면 아래를 적용한다.

1. 현실적인 eval 프롬프트 2~3개를 정한다. 파일로 남기지 말고 대화 맥락에서 바로 사용한다.
2. 작업 공간은 Pi가 스캔하는 스킬 경로 **밖**에 둔다. `~/.pi/agent/skills/` 하위는 재귀 스캔되므로 iteration 폴더의 `SKILL.md`까지 로딩돼 원본과 이름이 충돌한다.
   - 예: `/tmp/skill-eval/<skill-name>/iteration-1/...`
   - 꼭 스킬 경로 안에 둬야 한다면 해당 디렉터리를 `.ignore`에 넣어 스캔에서 제외한다.
3. 가능한 경우 Pi CLI로 with-skill / baseline을 비교한다.

```bash
# with skill
pi --no-skills --skill /path/to/skill -p "<eval prompt>"

# baseline
pi --no-skills -p "<same eval prompt>"
```

4. 오래 걸리는 유한 비대화형 명령은 `bash_async`로 실행하고 completion follow-up을 기다린다. TUI·REPL·stdin 입력이 필요하면 `tmux-terminal` 스킬의 helper를 사용한다.
5. 독립 판단이 중요한 경우에만 `subagent`를 사용한다. subagent를 쓰면 먼저 `subagent help`로 인터페이스를 확인하고, 같은 eval의 with-skill/baseline을 가능하면 batch로 띄운다.
6. 결과는 숫자보다 사용자 피드백을 우선한다. 단, 반복되는 실패는 스킬 본문이 아니라 `scripts/`나 `references/`로 구조화할 수 있는지 본다.

### 6. Description/trigger 개선

트리거 정확도를 개선할 때:

1. 실제 사용자가 말할 법한 쿼리 10~20개를 만든다.
   - should-trigger: 5~10개
   - should-not-trigger: 5~10개
   - 너무 쉬운 negative보다 비슷하지만 다른 작업인 near-miss를 포함한다.
2. 각 쿼리에 대해 현재 description에서 어떤 키워드/상황이 부족한지 분석한다.
3. 새 description은 목적과 호출 상황만 담은 1~2문장으로 유지한다.
   - 부족한 상황은 예시 문구를 나열하지 말고 일반화한 단어로 보강한다.
   - 쓰지 말아야 할 가까운 상황, 구현 방식, 세부 옵션은 본문에 둔다.
4. 과적합하지 않는다. 특정 eval 문장을 그대로 나열하지 말고 일반화한다.

### 7. 검증

스킬 작성/수정 후 반드시 아래를 확인한다. 스크립트는 이 스킬이 로드된 디렉터리 기준 절대 경로로 실행한다.

```bash
python3 "<loaded-skill-dir>/scripts/validate_skill.py" /path/to/skill
```

검증 스크립트는 다음을 본다(요약).

- 에러(exit 1): `SKILL.md` 존재, frontmatter가 유효한 YAML 매핑인지, `name`/`description` 유무, `name` 글자 규칙, `name` 64자·`description` 1024자·`compatibility` 500자 초과
- 경고(exit 0): `name`과 디렉터리명 불일치, `description`이 너무 짧거나 김, 500줄 초과, 본문에서 가리키는 `references/`·`scripts/`·`assets/` 파일이 없음(백틱 안도 검사), 사용자별 절대 경로, `allowed-tools` 형식, 알려지지 않은 frontmatter 필드

경고가 있으면 `OK with warnings (N)`으로 끝나고 exit 0이다. "통과"라고만 보고하지 말고 경고를 읽고 처리하거나 왜 무시해도 되는지 적는다. `python3`가 없으면 검증을 건너뛰고 `references/pi-skill-checklist.md`로 수동 점검한 뒤 그 사실을 보고한다.

추가 사람 검토:

- `references/pi-skill-checklist.md`를 열어 구조·트리거·안전 항목을 훑는다
- 본문이 너무 길면 `references/`로 분리했는가
- 스킬이 위험한 행동을 암묵적으로 지시하지 않는가
- 새 스킬을 글로벌에 추가했다면 사용자가 `/reload` 또는 새 세션을 시작해야 한다는 점을 안내했는가
- 격리 테스트가 필요하면 `pi --no-skills --skill /path/to/skill -p "<쿼리>"`로 재현 가능한지 확인
- 최종 보고에 생성/수정 파일과 검증 결과 포함

## Output format

최종 응답은 짧게:

```markdown
완료했습니다.
- 생성/수정: `path/to/SKILL.md`, ...
- 검증: validate_skill.py 통과(경고 0건)
```

사용자에게 다음 행동이 필요하면 한 줄로만 묻는다. 예: "트리거 eval까지 돌려볼까요?"
