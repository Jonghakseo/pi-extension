# @ryan_nookpi/pi-extension-ask-user-question

pi에서 `ask_user_question` 도구를 추가해, 사용자에게 여러 질문을 한 번에 구조화해서 받을 수 있게 해주는 익스텐션입니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-extension-ask-user-question
```

## 무엇을 할 수 있나

- `radio`: 하나만 고르는 단일 선택 질문
- `checkbox`: 여러 개를 고르는 복수 선택 질문
- `text`: 자유 입력 질문
- `allowOther: true`: 선택지 외 값을 직접 입력하는 `기타...` 경로 제공
- 여러 질문을 한 번의 폼으로 묶어 입력 받기

## 언제 쓰면 좋은가

- 요구사항이 모호해서 확인이 필요할 때
- 여러 선택지 중 하나를 고르게 해야 할 때
- 선호도, 배포 환경, 옵션 조합 등을 한 번에 수집할 때
- 일반 텍스트 질문보다 구조화된 응답이 필요할 때

## 파라미터 가이드

### 최상위 필드

- `title`: 폼 상단 제목
- `description`: 폼 설명/안내 문구
- `questions`: 질문 배열

### 질문 필드

- `id`: 질문 식별자
- `type`: `radio` | `checkbox` | `text`
- `prompt`: 사용자에게 보여줄 질문 문구
- `label`: 탭에 표시할 짧은 이름. 생략하면 `Q1`, `Q2`처럼 자동 생성
- `options`: `radio`/`checkbox`에서 사용할 선택지 목록
- `allowOther`: `기타...` 직접 입력 허용 여부
- `required`: 필수 응답 여부
- `placeholder`: `text` 입력창 플레이스홀더
- `default`: 기본값. `radio`/`text`는 문자열, `checkbox`는 문자열 배열

### 옵션 필드

- `value`: 실제 반환값
- `label`: 화면에 보이는 문구
- `description`: 선택지 아래 보조 설명

## 예시

```json
{
  "title": "배포 설정 확인",
  "description": "진행 전에 몇 가지 선택이 필요합니다.",
  "questions": [
    {
      "id": "env",
      "type": "radio",
      "prompt": "어느 환경에 배포할까요?",
      "options": [
        { "value": "staging", "label": "스테이징" },
        { "value": "prod", "label": "프로덕션" }
      ]
    },
    {
      "id": "targets",
      "type": "checkbox",
      "prompt": "이번에 함께 반영할 항목은 무엇인가요?",
      "options": [
        { "value": "web", "label": "웹" },
        { "value": "admin", "label": "어드민" }
      ]
    },
    {
      "id": "notes",
      "type": "text",
      "prompt": "추가로 알아야 할 점이 있나요?",
      "required": false,
      "placeholder": "선택 사항"
    }
  ]
}
```

## 반환 형태

응답은 각 질문의 `id` 기준으로 정리되어 반환됩니다. 취소 시에는 `cancelled: true`가 내려오고, 완료 시에는 질문별 답변 목록이 포함됩니다.
