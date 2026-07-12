# @ryan_nookpi/pi-extension-todo-write

> **⚠️ Deprecated.** 이 패키지는 더 이상 유지보수되지 않습니다. 대신 [`@ryan_nookpi/pi-extension-todo-write-overlay`](https://github.com/Jonghakseo/pi-extension/tree/main/packages/todo-write-overlay)를 사용하세요.

pi가 현재 세션에서 구조화된 작업 목록을 만들고 갱신할 수 있게 해주는 `todo_write` 익스텐션입니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-extension-todo-write
```

## 무엇을 해결하나

- 큰 작업을 여러 단계로 나눠서 관리
- 현재 진행 중인 작업을 사용자에게 명확히 보여줌
- 상태를 `pending` / `in_progress` / `completed`로 일관되게 유지
- 세션 압축(compaction) 이후에도 남은 작업을 이어서 추적

## 언제 쓰면 좋은가

- 구현, 디버깅, 리팩터링처럼 단계가 많은 작업
- 테스트/수정/검증을 따로 추적해야 하는 작업
- 도중에 요구사항이 바뀌어 계획을 다시 정리해야 하는 작업

## 작성 규칙

- `content`는 짧은 명령형으로 작성
  - 예: `테스트 실행`, `로그 확인`, `배포 검증`
- `activeForm`은 현재 진행 중 문구로 작성
  - 예: `테스트 실행 중`, `로그 확인 중`
- 동시에 `in_progress`인 작업은 하나만 유지
- 작업이 끝나면 바로 `completed`로 갱신
- 더 이상 의미 없는 항목은 목록에서 제거

## 파라미터 가이드

최상위 입력은 아래 형태입니다.

```json
{
  "todos": [
    {
      "content": "테스트 실행",
      "status": "in_progress",
      "activeForm": "테스트 실행 중",
      "notes": "핵심 시나리오부터 확인"
    }
  ]
}
```

### 필드 설명

- `content`: 작업 내용
- `status`: `pending` | `in_progress` | `completed`
- `activeForm`: 진행 중일 때 위젯에 보여줄 문구
- `notes`: 추가 메모

## 예시 프롬프트

- "작업 목록 만들고 단계별로 진행해줘."
- "이 작업을 구현/테스트/검증으로 나눠서 추적해줘."
- "디버깅 플랜을 todo로 관리하면서 진행해줘."

## 참고

- 이 익스텐션은 `todo_write` 도구 호출 시 내부 상태를 저장합니다.
- 세션 압축 이후에도 남은 작업이 있으면 이어서 진행할 수 있도록 리마인더를 남깁니다.
- 완료 항목은 위젯에서 일부만 노출되고, 나머지는 `완료 +N` 형태로 요약될 수 있습니다.
