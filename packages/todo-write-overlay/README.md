# @ryan_nookpi/pi-extension-todo-write-overlay

pi가 현재 세션에서 구조화된 작업 목록을 만들고 갱신할 수 있게 해주는 `todo_write` 익스텐션입니다. 할 일 목록은 입력창 위젯이 아니라 **우측 상단 passive overlay**로 표시됩니다.

![todo_write overlay in chat](./assets/todo-overlay-chat.png)

![todo_write overlay progress](./assets/todo-overlay-progress.png)

## 설치

```bash
pi install npm:@ryan_nookpi/pi-extension-todo-write-overlay
```

> `@ryan_nookpi/pi-extension-todo-write`와 같은 `todo_write` 도구 이름을 사용합니다. 두 익스텐션을 동시에 설치하지 않는 것을 권장합니다.

## 제공 기능

- `todo_write` 도구 등록
- 세션 단위 todo 상태 저장 및 복원
- 우측 상단 오버레이 렌더링
- 입력 포커스를 뺏지 않는 `nonCapturing` overlay 사용
- `/todo-overlay show` / `/todo-overlay hide` 명령으로 오버레이 표시 토글
- 진행 중 작업 스피너 표시
- 완료/진행/대기 상태별 색상과 아이콘 표시
- `notes`는 상태에는 보존하지만 오버레이에는 표시하지 않음
- compaction 이후 남은 todo reminder 주입

## 표시 방식

오버레이는 pi TUI의 `ctx.ui.custom(..., { overlay: true })`를 사용합니다.

- 위치: `top-right`
- 너비: 42 columns
- 여백: 위 1줄, 오른쪽 2 columns
- 표시 조건: 터미널 너비 70 columns 이상
- 입력 처리: `nonCapturing: true`

기존 `todo-write`의 `완료 +2` 같은 완료 항목 접기 로직은 사용하지 않습니다. 완료된 항목도 모두 그대로 표시합니다.

## 명령어

```text
/todo-overlay show
/todo-overlay hide
```

- 기본값은 `show`입니다.
- `hide`는 todo 상태와 reminder 주입은 유지하고, 우측 상단 오버레이 UI만 숨깁니다.
- 인자 없이 `/todo-overlay`를 실행하면 현재 표시 상태를 알려줍니다.

## 사용 예

처음 목록을 만들거나 큰 폭으로 재편할 때는 `op` 없이(기본 `replace`) 전체를 보냅니다.

```json
{
  "todos": [
    { "content": "설계 정리", "status": "completed" },
    { "content": "구현", "status": "in_progress", "activeForm": "구현 중" },
    { "content": "검증", "status": "pending" }
  ]
}
```

이미 목록이 있고 일부만 바꿀 때는 `op: "patch"`로 변경분만 보냅니다. 작업 수가 많을수록 args 크기가 변경분에만 비례해 저렴합니다.

```json
{
  "op": "patch",
  "set": [
    { "id": "task-1", "status": "completed" },
    { "id": "task-2", "status": "in_progress", "activeForm": "구현 중" }
  ],
  "add": [{ "content": "문서화", "status": "pending" }],
  "remove": ["task-5"]
}
```

- `set`/`add`/`remove`는 함께 쓸 수 있으며 remove → set → add 순서로 적용됩니다.
- `id`는 직전 `todo_write` 결과에 표시된 `task-N` 값을 참조합니다. 존재하지 않는 id는 결과 텍스트에 경고로 표시되고 무시됩니다.
- `add`로 추가되는 항목은 기존 id와 겹치지 않는 새 `task-N` id를 받습니다.

## 상태 필드

- `content`: 작업 설명
- `status`: `pending` | `in_progress` | `completed`
- `activeForm`: 진행 중일 때 오버레이에 보여줄 현재진행형 문구
- `notes`: 보조 메모

## 동작 메모

- `in_progress`가 여러 개 들어오면 첫 번째만 유지하고 나머지는 `pending`으로 정규화합니다.
- `in_progress`가 없고 `pending`이 있으면 첫 번째 `pending`을 자동으로 `in_progress`로 올립니다.
- 모든 항목이 완료되면 잠시 표시한 뒤 자동으로 숨깁니다.
