# Pi 업스트림 호환성 조사

이 문서는 `pi-extension` 모노레포를 Pi 본체의 다음 릴리스에 맞춰 업데이트할 때 같은 조사를 반복하지 않기 위한 기준 문서다.

## 조사 기준

아래 커밋을 직접 비교했다.

| 기준 | 버전 또는 커밋 | 상태 |
| --- | --- | --- |
| 현재 npm 배포판 | `@earendil-works/pi-* 0.84.3` | 이 모노레포가 사용하는 버전 |
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
   gh api repos/earendil-works/pi/compare/v0.84.3...main --jq '{status,ahead_by,behind_by,total_commits}'
   gh api repos/earendil-works/pi/compare/v0.84.3...dev --jq '{status,ahead_by,behind_by,total_commits}'
   ```

   새 릴리스가 나왔으면 `v0.84.3`을 새 tag로 바꾼다.

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
