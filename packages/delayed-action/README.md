# @ryan_nookpi/pi-extension-delayed-action

지정한 시간 뒤에 프롬프트를 다시 제출해 Pi 턴을 트리거하는 delay 익스텐션입니다.

이 패키지는 `/delay` 명령어와 `delay` tool을 제공합니다. 시간이 되면 예약한 프롬프트를 사용자 메시지처럼 제출하며, 에이전트가 작업 중이면 follow-up으로 큐잉합니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-extension-delayed-action
```

## 이런 때 좋아요

- 배포 후 몇 분 뒤 로그를 다시 확인하고 싶을 때
- 잠시 뒤에 후속 작업을 이어서 처리하고 싶을 때
- 같은 인터랙티브 세션 안에서 일회성 리마인더를 예약하고 싶을 때

## 사용 예시

```text
/delay 5m 상태 확인해줘
/delay 1h30m 회의록 정리 시작
/delay 2시간 배포 결과 확인
```

지원 단위:

- `ms`, `s`, `m`, `h`, `d`
- `초`, `분`, `시간`, `일`
- 조합형 예: `1h30m`

## 명령어

```text
/delay <duration> <prompt>     지연 후 프롬프트 제출
/delay list                    예약 목록 보기
/delay-cancel [id|all]         예약 취소, id 생략 시 전체 취소
```

## Tool

에이전트는 `delay` tool을 사용해 다음 형식으로 예약할 수 있습니다.

```json
{
  "delay": "5m",
  "prompt": "배포 로그 확인해줘",
  "id": "optional-id"
}
```

예약은 세션 내 메모리 기반이며, 세션 종료 시 취소됩니다. 반복/영구 스케줄링이 필요하면 cron 계열 기능을 사용하세요.
