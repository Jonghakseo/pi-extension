# @ryan_nookpi/pi-extension-delayed-action

지금이 아니라 조금 뒤에 다시 일을 시키고 싶을 때 쓰는 리마인더 익스텐션입니다.

자연어로 "10분 있다가 배포 로그 확인해줘"처럼 말하면, 시간이 되면 pi가 다시 그 작업을 이어서 요청합니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-extension-delayed-action
```

## 이런 때 좋아요

- 배포 후 몇 분 뒤 로그를 다시 확인하고 싶을 때
- 잠시 뒤에 후속 작업을 이어서 처리하고 싶을 때
- "조금 있다가 다시 봐줘" 같은 흐름을 자동화하고 싶을 때

## 사용 예시

- "10분 있다가 배포 로그 확인해줘"
- "1시간 후에 에러율 다시 체크해줘"
- "좀 있다가 PR 코멘트 다시 확인해줘"

## 함께 쓰는 명령어

```text
/reminders
/reminder-cancel <id>
/reminder-cancel all
```

예약된 작업 목록을 보거나, 특정 리마인더 또는 전체 리마인더를 취소할 수 있습니다.
