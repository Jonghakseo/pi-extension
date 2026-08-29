# @ryan_nookpi/pi-extension-until

조건이 충족될 때까지 Pi가 같은 작업을 주기적으로 다시 실행하도록 만드는 익스텐션입니다. PR 상태, 배포 완료, 외부 응답처럼 "조금 뒤에 다시 확인"해야 하는 작업에 적합합니다.

Pi `0.84.3` 이상이 필요합니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-extension-until
```

## 명령어

```text
/until <간격> <프롬프트>
/until <프리셋>
/until <간격> <프리셋>
/untils
/until-cancel <id|all>
```

예시:

```text
/until 5m PR 코멘트 확인해줘
/until 1h 배포 상태 다시 점검해줘
/until REVIEW
/until 10m REVIEW
/untils
/until-cancel 1
/until-cancel all
```

인자 없는 `/until-cancel`은 작업을 취소하지 않고 사용법만 표시합니다.

## 동작 방식과 제한

- 등록 직후 첫 회차를 실행합니다.
- 반복 간격에는 충돌을 줄이기 위해 ±10% jitter가 적용됩니다.
- 최소 간격은 1분, 최대 동시 작업은 3개입니다.
- 각 작업은 등록 후 최대 24시간 유지됩니다.
- 상태는 메모리에만 저장됩니다. Pi 프로세스 종료, `/new`, `/resume`, `/fork` 같은 session switch를 넘겨 유지되지 않습니다.
- 프로세스 재시작 뒤에도 실행해야 하는 영속 일정은 `until` 대신 `cron`을 사용하세요.

## `until_report` 계약

각 회차 프롬프트에는 `taskId`와 `runCount`가 포함됩니다. 작업을 한 번 수행한 뒤 두 값을 그대로 전달해 결과를 보고해야 합니다.

```text
until_report({
  taskId: 1,
  runCount: 2,
  done: false,
  summary: "배포 진행 중"
})
```

- `done: false`는 다음 회차를 유지합니다.
- `done: true`는 task와 timer를 제거하고 반복을 종료합니다.
- 현재 회차와 다른 `runCount`, 이미 정리된 회차의 report는 거부됩니다.

## 개인 프리셋

프리셋은 `$PI_CODING_AGENT_DIR/until-presets`에서 읽습니다. `PI_CODING_AGENT_DIR`을 지정하지 않았다면 기본 위치는 `~/.pi/agent/until-presets`입니다. 파일은 `/until`을 실행할 때마다 다시 읽으므로 수정 뒤 reload가 필요하지 않습니다.

예를 들어 `REVIEW.md`를 다음처럼 작성합니다.

```md
---
interval: 15m
description: PR review status check
---

Check the current PR once, then call until_report.
```

- `/until REVIEW`는 frontmatter의 `interval`을 사용합니다.
- `/until 10m REVIEW`는 프리셋 interval을 `10m`으로 덮어씁니다.
- `interval` 기본값은 `5m`, `description` 기본값은 정규화된 파일 이름입니다.
- 잘못된 frontmatter, 빈 본문, 지원하지 않는 interval의 파일은 자동완성에서 제외됩니다.
- 개인 프리셋 파일은 npm 패키지에 포함되지 않습니다.
