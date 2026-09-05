# Pi 업스트림 호환성 조사

이 문서는 `pi-extension` 모노레포를 Pi 본체의 다음 릴리스에 맞춰 업데이트할 때 같은 조사를 반복하지 않기 위한 기준 문서다.

## 0.85.0 업데이트 조사 (2026-09-05)

- 전역 CLI와 npm 최신 정식 릴리스는 `0.85.0`이다. 저장소 SDK의 적용 대상은 `0.84.3 → 0.85.0`이다.
- 버전 소유자는 루트 `package.json`이다. `devDependencies` 3개와 `pnpm.overrides` 4개를 함께 올린다.
- `packages/*/package.json` 24개는 Pi를 optional peer로 선언한다. `until`의 `>=0.84.3`, 나머지 `*` 지원 범위는 그대로 유지한다.
- workspace는 루트 `pnpm-workspace.yaml`, 패키지 매니저는 `pnpm@10.24.0`, lockfile은 `pnpm-lock.yaml`이다. lockfile은 기존 `.gitignore` 정책에 따라 Git에서 추적하지 않으며 로컬 파일만 갱신한다. 별도 build 스크립트 없이 TypeScript 소스를 배포한다.
- 적용되는 `AGENTS.md`와 별도 upgrade/runbook은 발견되지 않았다. 아래 재점검 절차와 `pnpm run verify:strict`가 저장소 검증 기준이다.
- manifest 없는 추가 extension source는 발견되지 않았다. `pi-caveman/`에는 설치 산출물만 있어 소유자에서 제외했다.

공식 [coding-agent 변경 내역](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/CHANGELOG.md), [pi-ai 변경 내역](https://github.com/earendil-works/pi/blob/v0.85.0/packages/ai/CHANGELOG.md), [pi-tui 변경 내역](https://github.com/earendil-works/pi/blob/v0.85.0/packages/tui/CHANGELOG.md), [agent 변경 내역](https://github.com/earendil-works/pi/blob/v0.85.0/packages/agent/CHANGELOG.md)의 `0.84.4`와 `0.85.0`을 확인했다. `Unreleased`는 적용 대상이 아니다.

### 변경 내역과 코드 영향

| 릴리스 변경 | 현재 사용처 | 판단과 조치 |
| --- | --- | --- |
| `0.84.4`의 `triggerTurn: false` 메시지 순서 보존 | `subagent/{commands,lifecycle,tool-execute}.ts`의 비트리거 메시지 | SDK 수정 혜택을 받는다. 로컬 완료 전달·중복 방지 로직은 별도 계약이므로 유지한다. |
| `0.84.4`의 도구 실행 사이 자동 압축, `prepareNextTurn` 실행 시점 변경 | `until/index.ts`의 `agent_settled`, `subagent` 세션 재생·컨텍스트 보호 | `prepareNextTurn` 직접 사용은 없다. 기존 세션·중단·재생 테스트로 회귀를 확인한다. |
| `0.84.4`의 `ui_prompt_start/end` 공개 이벤트 | `idle-screensaver/index.ts`의 `AskUserQuestion` 감시, `ask-user-question`의 `ctx.ui.custom()` | 대체 후보 보류. peer가 구버전을 허용하며, 모든 UI 대기까지 감시 범위를 넓히는 것은 동작 변경이다. |
| `0.84.4`의 이미지 MIME 탐지 공개 export | `diff-review/git.ts`의 `imageMimeTypes` | 유지. Git revision의 경로 분류와 현재 디스크 파일 내용 탐지는 다르며, 지원 이미지 형식도 동일하지 않다. |
| `0.85.0`의 편집기 내장 작업 표시기 | `claude-spinner/index.ts`, `subagent/mentions.ts`의 `CustomEditor` 프록시 | `setWorkingIndicator`와 색상 지정 계약은 유지된다. 기본 프레임과 사용자 정의 프레임은 다르므로 익스텐션 삭제 대상이 아니다. 실제 TUI 조합은 수동 확인 대상이다. |
| `0.85.0`의 provider 스트림·Codex SSE 종료 처리, Claude effort 보존 | `codex-fast-mode/index.ts`, `auto-name/utils/short-label.ts`, `subagent/{runner,utils/short-label}.ts` | 공개 adapter를 통한 수정 혜택을 받는다. `service_tier: "priority"` 주입과 자식 프로세스 종료 fallback은 이 수정이 대체하지 않으므로 유지한다. |
| `0.85.0`의 `SessionManager.inMemory()` 복원과 fork 경계 수정 | `subagent`의 파일 기반 세션 복구, `delayed-action`의 세션별 저장 | 공개 복원 API가 파일 오프셋·자식 프로세스 생명주기까지 대신하지 않는다. 기존 저장·재생 계약을 유지한다. |
| `0.85.0`의 기본 도구 `ctx.cwd` 수정 | `bash-async/job-manager.ts` 등 자체 프로세스 실행 | 기본 도구의 수정과 비동기 작업 관리 기능은 별개다. 직접 cwd 전달을 유지한다. |
| `0.85.0`의 `createGatewayBindingFetch` 교체 및 TUI 환경 변수 기본값 제거 | 전체 `packages/**/*.ts`, `tests/**/*.ts` 검색 | 해당 API, `new TUI/TuiAltScreen`, 관련 환경 변수의 직접 사용이 없어 필수 수정 대상이 아니다. |
| `0.85.0`의 pi-ai 세분화된 공개 subpath | `codex-fast-mode`, `auto-name`, `subagent`, `bash-async`의 `/compat` import | 대체 후보 보류. 기존 `/compat`도 공개 API이며, 새 subpath 도입을 위한 최소 peer 버전 상향과 동작 보호 근거가 필요하다. |

공개 계약 근거는 [extension 타입](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/src/core/extensions/types.ts), [UI 대기 이벤트](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/docs/extensions.md#ui_prompt_start--ui_prompt_end), [작업 표시기 변경](https://github.com/earendil-works/pi/pull/8799), [Codex SSE 수정](https://github.com/earendil-works/pi/issues/9047)이다.

개선 검토의 대표 7건은 유지 5건(`setWorkingIndicator`, `imageMimeTypes`, `service_tier` 주입, 자식 종료 fallback, 파일 기반 세션 복구), 대체 보류 2건(UI 대기 감시, `/compat` import)이다. 안전하게 적용할 선택적 단순화·대체·삭제는 없었다. 실제 런타임 검증에서 아래 필수 의존성 보정 1건을 추가했다. 익스텐션 구현 변경은 없다.

### 필수 보정: SDK의 미선언 런타임 의존성

`0.85.0` 설치 후 타입 검사는 통과하지만 `await import("@earendil-works/pi-coding-agent")`가 `ERR_MODULE_NOT_FOUND`로 실패한다. 공개 root의 `index.js → main.js → experimental/server.js` 정적 import가 `@earendil-works/pi-server`를 요구하는데 배포 manifest에는 해당 의존성이 없다. bundled CLI는 이 코드를 인라인으로 포함하므로 `pi -v` 성공만으로 SDK import를 검증할 수 없다.

공식 수정 [PR #9170](https://github.com/earendil-works/pi/pull/9170)과 같은 누락을 확인했다. 저장소 루트 `package.json`에 아래 보정을 적용해 SDK 자체의 의존성으로 설치한다. 각 익스텐션의 peer를 변경하거나 private import로 우회하지 않는다.

```json
"packageExtensions": {
  "@earendil-works/pi-coding-agent@0.85.0": {
    "dependencies": {
      "@earendil-works/pi-server": "0.85.0"
    }
  }
}
```

- `tests/pi-sdk-import.test.ts`가 실제 public root import를 실행한다. 보정 전 실패, 보정 후 성공을 확인했다.
- 최초 `pnpm install`은 로컬 설치 트리에서 17개 추가·11개 제거를 보고했고 Pi 계열을 `0.85.0`으로 교체했다. SDK는 `chord`를 직접 의존성으로 추가했고, `pi-ai`는 반대로 불필요한 `chord` 직접 의존성을 제거했다. `pi-client`, `pi-protocol`, `pi-telemetry`도 같은 계열로 해석된다. 이후 보정 설치에서는 `pi-server@0.85.0` 1개만 추가되었다. 다른 직접 의존성 선언은 바꾸지 않았다.
- lockfile은 Git 비추적 파일이므로 저장소 diff에는 나타나지 않는다. 설치 전 사본을 보존하지 못해 비 Pi 전이 의존성 전체의 전후 diff는 확인하지 못했다.
- 이 보정은 이 저장소의 pnpm 설치에만 적용된다. 익스텐션 npm 패키지에 전파되는 수정이 아니므로, 외부 SDK 사용자의 `0.85.0` 설치 문제까지 해결했다고 해석하면 안 된다.
- 제거 조건은 새 정식 릴리스 manifest가 `pi-server`를 선언하고, 보정 없이 깨끗한 설치에서 실제 import·전체 검증이 통과하는 것이다. 이후 버전에는 현재의 정확한 `0.85.0` selector가 적용되지 않는다.

### 검증 기록

- 변경 전 `pnpm run verify:strict`는 103개 파일, 1,340개 테스트와 지정된 파일의 100% 커버리지를 통과했다.
- 보정 후 `pnpm run typecheck`와 핵심 패키지·신규 import 회귀 테스트는 55개 파일, 736개 테스트를 통과했다.
- 최종 `pnpm run verify:strict`는 Biome 267개 파일, TypeScript, 104개 테스트 파일의 1,341개 테스트, 24개 패키지의 배포 파일 구성 검사, 지정된 소스의 100% 커버리지를 모두 통과했다. 커버리지는 statements 823/823, branches 627/627, functions 142/142, lines 742/742이며 저장소 전체 소스의 커버리지 수치가 아니다.
- `pnpm install --frozen-lockfile --ignore-scripts`가 변경 없이 성공했고 `git diff --check`도 통과했다. 실제 ESM import와 SDK에서 해석하는 `pi-agent-core`, `pi-server`, `pi-client`, `pi-protocol`, `chord`의 `0.85.0` 버전을 확인했다. CommonJS `require.resolve`는 ESM 전용 export에 사용할 수 없으므로 진단에도 `import.meta.resolve`를 사용한다.
- 임시 HOME·TMPDIR·agent 디렉터리, 빈 cwd, `PI_OFFLINE=1` 환경에서 실제 `discoverAndLoadExtensions()`로 24개 entrypoint의 factory와 등록 결과를 확인했다. `session_start`, 도구 실행, 지연 초기화 완료, TUI 렌더링은 이 스모크의 검증 범위가 아니다.
- 설치 중 `esbuild` build-script 차단 경고가 있었다. 허용 정책은 변경하지 않았으며 타입 검사와 Vitest 실행에는 문제가 없었다.
- 실제 TUI에서 `claude-spinner`와 `subagent` 편집기의 작업 표시 위치·색상·멘션 조합은 후속 수동 확인 대상이다.

### 업스트림 브랜치 상태

조사 시점의 최신 정식 태그는 [`v0.85.0`](https://github.com/earendil-works/pi/releases/tag/v0.85.0)이며, `main`은 태그보다 5커밋 앞선다. `v0.85.0...dev` 비교와 `dev` 문서는 더 이상 조회되지 않았다(HTTP 404). 아래 `dev`/facet 분석은 과거 snapshot 기록이며 현재 브랜치 상태로 해석하면 안 된다. 실험 API를 대상으로 선행 포팅하지 않는다.

## 0.84.3 당시 조사 기준 (과거 기록)

아래 커밋을 직접 비교했다. 이 절부터 권고까지의 비교 결과는 당시 snapshot에 한정된다.

| 기준 | 버전 또는 커밋 | 상태 |
| --- | --- | --- |
| 당시 npm 배포판 | `@earendil-works/pi-* 0.84.3` | 당시 모노레포의 사용 버전 |
| 릴리스 태그 | [`v0.84.3`](https://github.com/earendil-works/pi/releases/tag/v0.84.3), `4e58f324` | 비교 기준 |
| 업스트림 `main` | [`4e494929`](https://github.com/earendil-works/pi/commit/4e494929998d6bc4fccf75e0a233f727db4b70ee) | `v0.84.3`보다 34커밋 앞섬 |
| 업스트림 `dev` | [`1d0d110a`](https://github.com/earendil-works/pi/commit/1d0d110ab471a277d568f497c9cdb46cbdeeca68) | `v0.84.3`보다 324커밋 앞섬 |

`main`과 `dev`는 단순한 선후 관계가 아니다. GitHub compare API 기준으로 `dev`는 `main`에만 있는 커밋 30개를 포함하지 않고, 공통 merge base 이후 `dev`에만 있는 커밋은 320개다. `dev`의 `package.json` 버전도 아직 `0.84.3`이므로 다음 릴리스의 확정 API로 취급하면 안 된다.

## 결론

- `main`은 기존 coding-agent extension API를 유지하면서 이벤트와 공개 타입을 추가한 증분 업데이트다.
- 큰 인터페이스 변경은 `dev`의 `AgentHarness`와 실험적 facet/service 아키텍처에 집중되어 있다.
- 현재 이 모노레포는 `dev`에서 breaking change가 선언된 harness API를 직접 사용하지 않는다.
- 따라서 현재 소스 수준 위험은 낮다. 다만 facet 아키텍처가 기존 extension 시스템을 대체하기 시작하면 TUI와 세션을 함께 다루는 익스텐션은 구조 변경이 필요하다.

이 판정은 업스트림 소스와 공개 타입을 비교한 결과다. `main` 또는 `dev` 패키지를 실제 빌드해 이 모노레포 전체를 typecheck한 결과는 아니다.

## `v0.84.3`에서 `main`으로의 변화

공식 [`main` coding-agent changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)에는 미배포 breaking change가 없다.

extension 관련 핵심 변화는 다음과 같다.

- `ui_prompt_start`와 `ui_prompt_end` 이벤트 추가
  - `ctx.ui.select()`, `confirm()`, `input()`, `editor()`, `custom()`이 사용자를 기다리는 구간을 호스트가 구분할 수 있다.
  - 기존 handler나 `ExtensionAPI` 메서드를 변경하지 않는 additive API다.
  - 공식 문서: [`extensions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#ui_prompt_start--ui_prompt_end)
- `ToolExecutionStartEvent`, `ToolExecutionUpdateEvent`, `ToolExecutionEndEvent`의 public export 보강
- `detectSupportedImageMimeTypeFromFile` 공개 export 추가
- RPC `clear_queue` 추가
- 실행 중 `triggerTurn: false`로 보낸 extension message가 tool call과 result 사이에 끼지 않도록 수정
- TUI fullscreen, terminal capability, session file, compaction 관련 버그 수정

현재 공개된 `ExtensionAPI`, `ExtensionContext`, tool registration 계약에는 제거나 필수 인자 변경이 없다.

## `v0.84.3`에서 `dev`로의 변화

`dev`의 핵심은 기존 coding-agent extension API 개편이 아니라 durable harness와 멀티프로세스 application host 실험이다.

### Durable harness

공식 [`dev` agent changelog](https://github.com/earendil-works/pi/blob/dev/packages/agent/CHANGELOG.md)의 breaking change는 다음 영역에 있다.

- unfinished harness runtime과 record-log session model을 새로운 durable 계약으로 교체
- `AgentHarnessTool.execute()`에 replay-stable invocation metadata 인자 추가
- storage backend의 `CommitResult.stats`에 정확한 post-commit `SessionStats` 요구
- 기존 manual-drive 설정과 action inspection API 제거

새 공개 모델은 대략 다음과 같다.

```text
Session
  └─ Branch
      └─ AgentLane
          ├─ accept(operation)
          ├─ drive(operationId)
          ├─ requestAbort(operationId)
          ├─ prompt / compact / navigateTree
          └─ watch() -> LaneSnapshot + events
```

주요 성질:

- prompt, tool call, retry, abort, compaction을 durable operation state로 기록한다.
- 프로세스가 죽어도 저장된 operation과 invocation ID를 기준으로 복구하거나 안전하게 중단한다.
- tool effect replay를 위해 stable `invocationId`, `operationId`, `turnId`, durable memo를 제공한다.
- session, branch, lane을 분리하고 snapshot + event reducer를 presentation 경계로 사용한다.

공식 상세 계약: [`AgentHarness` implementation specification](https://github.com/earendil-works/pi/blob/dev/packages/agent/docs/harness.md)

### Facet와 service 아키텍처

공식 [`plugins.md`](https://github.com/earendil-works/pi/blob/dev/packages/agent/docs/plugins.md)는 **experimental facet and service architecture의 design specification**이라고 명시한다.

현재 extension과의 가장 큰 개념 차이는 다음과 같다.

| 현재 extension 모델 | 실험적 facet 모델 |
| --- | --- |
| 하나의 default factory가 `ExtensionAPI`를 받음 | 기능 하나가 host별 `Facet[]` bundle로 나뉨 |
| session, tool, TUI 코드가 같은 프로세스에서 객체를 공유 | session worker, presentation, server가 별도 프로세스에서 실행 |
| `ctx.ui`로 TUI를 직접 조작 | presentation facet이 host-local TUI service를 사용 |
| extension이 session context와 UI를 함께 접근 | session facet만 실제 Harness와 session authority를 가짐 |
| JavaScript 객체와 callback을 직접 전달 | strict JSON DTO, typed service, `ReplicatedState`로 통신 |
| `/reload`로 extension 전체 교체 | service shape가 같으면 facet reload, shape 변경이면 process 교체 |

예상 topology:

```text
TUI / web presentation
        │
        │ typed services, replicated state
        ▼
      server
        │
        ▼
session worker
  └─ AgentHarness / AgentLane / tools / credentials
```

presentation facet은 raw Harness, Session, tool registry, hook, credential을 받지 않는다. session facet이 authority를 가지고 필요한 기능만 service로 노출한다.

실험용 [`mini`](https://github.com/earendil-works/pi/blob/dev/packages/coding-agent/src/experimental/mini/README.md)는 이 구조를 실제 멀티프로세스로 시험하지만, 아직 slash command, extension, skill, hook을 지원하지 않는다고 명시한다. 따라서 facet 기반 extension migration API는 아직 완성된 것으로 볼 수 없다.

## 이 모노레포 영향 분석

breaking harness API 사용 여부를 다음 패턴으로 확인했다.

```bash
rg -n '\b(AgentHarness|SessionRepo|SessionStorage|AgentHarnessTool|CommitResult|ExecutionEnv|LaneSnapshot|AgentLane)\b' packages --glob '*.ts'
```

결과는 0건이었다.

`@earendil-works/pi-agent-core`를 직접 import하는 곳은 `packages/subagent/types.ts`의 `AgentToolResult` 하나뿐이다.

```ts
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
```

`AgentToolResult` 선언은 `v0.84.3`과 조사한 `dev` 커밋에서 동일한 위치와 형태로 유지된다. 나머지 패키지는 주로 다음 공개 API를 사용한다.

- `@earendil-works/pi-coding-agent`: `ExtensionAPI`, `ExtensionContext`, events, theme와 UI helper
- `@earendil-works/pi-tui`: TUI components와 rendering helper
- `@earendil-works/pi-ai` 또는 `/compat`: message types, model lookup, completion helper

조사한 `dev` 커밋에서는 다음도 확인했다.

- `packages/coding-agent/src/core/extensions/types.ts`와 public extension index는 `v0.84.3` 대비 변경 없음
- `packages/tui/src/index.ts` 변경은 mouse 관련 export 추가
- `packages/ai/src/index.ts` 변경은 assistant message frame utility export 추가
- 기존 `Message`, `AgentToolResult`, TUI import surface 제거 없음

따라서 현재 `dev` snapshot만으로 기존 익스텐션이 즉시 깨질 근거는 없다.

## 향후 영향이 큰 익스텐션

facet 모델이 실제 coding-agent extension 시스템으로 들어오면 다음 패키지를 먼저 살펴본다.

| 위험 | 패키지 | 이유 |
| --- | --- | --- |
| 높음 | `ask-user-question`, `generative-ui`, `memory-layer`, `todo-write-overlay`, `idle-screensaver` | session-side 동작과 직접적인 TUI component/modal 상태가 결합됨 |
| 높음 | `subagent` | tool 실행, session lifecycle, background process, custom editor와 TUI가 한 extension에 결합됨 |
| 중간 | `auto-name`, `headroom`, `todo-write`, `until` | context/session event와 저장 상태 계약에 의존 |
| 중간 | `codex-fast-mode`, `codex-large-context` | provider와 model authority가 session service로 이동할 가능성 |
| 낮음 | 단순 command/tool 등록 패키지 | host별 bundle 분리는 필요할 수 있지만 상태와 UI 결합이 적음 |

위 위험도는 현재 고장 여부가 아니라 facet 전환 시 예상 migration 비용이다.

## 다음 업그레이드 때 재점검할 것

1. npm 최신 버전과 release tag를 확인한다.

   ```bash
   npm view @earendil-works/pi-coding-agent version dist-tags --json
   gh api repos/earendil-works/pi/releases/latest --jq '{tag_name,published_at}'
   ```

2. release tag와 `main`, `dev`의 거리를 확인한다.

   ```bash
   gh api repos/earendil-works/pi/compare/v0.85.0...main --jq '{status,ahead_by,behind_by,total_commits}'
   # dev 브랜치가 다시 제공되는 경우에만 실행한다.
   gh api repos/earendil-works/pi/compare/v0.85.0...dev --jq '{status,ahead_by,behind_by,total_commits}'
   ```

   새 릴리스가 나왔으면 `v0.85.0`을 새 tag로 바꾼다. 브랜치나 문서가 404이면 과거 snapshot과 현재 API를 구분해 기록한다.

3. 공식 changelog와 extension/facet 문서를 먼저 읽는다.

   - [`packages/coding-agent/CHANGELOG.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md)
   - [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
   - [`packages/agent/CHANGELOG.md`](https://github.com/earendil-works/pi/blob/dev/packages/agent/CHANGELOG.md)
   - [`packages/agent/docs/harness.md`](https://github.com/earendil-works/pi/blob/dev/packages/agent/docs/harness.md)
   - [`packages/agent/docs/plugins.md`](https://github.com/earendil-works/pi/blob/dev/packages/agent/docs/plugins.md)

4. 이 모노레포의 Pi import surface와 high-risk API 사용을 다시 검색한다.

   ```bash
   rg -n '@earendil-works/pi-(coding-agent|agent-core|ai|tui)' packages --glob '*.ts'
   rg -n '\b(AgentHarness|SessionRepo|SessionStorage|AgentHarnessTool|CommitResult|ExecutionEnv|LaneSnapshot|AgentLane)\b' packages --glob '*.ts'
   ```

5. 버전을 올릴 때 root `package.json`의 `pnpm.overrides`, `devDependencies`, `pnpm-lock.yaml`을 함께 갱신하고 다음을 실행한다.

   ```bash
   pnpm run verify:strict
   ```

6. facet 기반 extension loader, manifest, host bundle 규칙이 공식 문서에 등장하기 전에는 `dev`를 목표로 선행 포팅하지 않는다.

## 권고

- 다음 정식 릴리스가 현재 `main` 수준이라면 일반 dependency update로 처리한다.
- `dev`의 facet 설계는 추적하되 구현 대상으로 삼지 않는다.
- 공식 extension 문서에 host별 facet packaging 또는 기존 `ExtensionAPI` deprecation이 명시되면 별도 migration 작업을 시작한다.
- 가능하면 다음 Pi 버전 업데이트 때 정식 배포 패키지와 업스트림 `main`을 각각 사용하는 typecheck 테스트를 추가한다.
