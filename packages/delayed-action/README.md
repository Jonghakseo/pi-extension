# @ryan_nookpi/pi-extension-delayed-action

지정한 시간 뒤에 프롬프트를 다시 제출해 Pi 턴을 트리거하는 delay 익스텐션입니다.

이 패키지는 `/delay` 명령어와 `delay` tool을 제공합니다. 시간이 되면 예약한 프롬프트를 사용자 메시지처럼 제출하며, 에이전트가 작업 중이면 follow-up으로 큐잉합니다.

예약은 세션별로 디스크(`~/.pi/delayed-action/<sessionId>.json`)에 저장되어 **compaction, `/reload`, pi 재시작이나 세션 resume 이후에도 유지**됩니다. 세션을 다시 열면 남은 예약이 자동으로 복원되고, pi가 꺼져 있는 동안 시간이 지난 예약은 세션이 준비된 직후 실행됩니다.

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
/delay list                    예약 목록을 텍스트로 보기
/delay-list                    예약을 골라 바로 보내기/수정/취소
/delay-cancel [id|all]         예약 취소, id 생략 시 전체 취소
```

`/delay-list`를 실행하면 예약된 메시지를 선택한 뒤 다음 작업을 할 수 있습니다.

- **지금 보내기**: 타이머를 제거하고 메시지를 즉시 제출합니다. 에이전트가 작업 중이면 follow-up으로 보냅니다.
- **수정**: 새 지연 시간과 메시지를 입력합니다. 지연 시간은 수정 완료 시점부터 다시 계산됩니다.
- **예약 취소**: 선택한 예약을 취소합니다.

## Tool

에이전트는 `delay` tool을 사용해 다음 형식으로 예약할 수 있습니다.

```json
{
  "delay": "5m",
  "prompt": "배포 로그 확인해줘",
  "id": "optional-id"
}
```

예약은 세션별 파일로 영속화되어 compaction·재시작·resume 이후에도 유지됩니다. 저장 위치는 `~/.pi/delayed-action/<sessionId>.json`이며, `PI_DELAYED_ACTION_DIR` 환경 변수로 바꿀 수 있습니다. 반복/영구 스케줄링이 필요하면 cron 계열 기능을 사용하세요.
