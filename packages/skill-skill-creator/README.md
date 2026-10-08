# @ryan_nookpi/pi-skill-skill-creator

Pi 스킬을 만들고 고치고 검증하는 스킬입니다. `SKILL.md` frontmatter, description 트리거, `references/`·`scripts/` 분리, 작은 eval 설계를 안내하고 `validate_skill.py`로 형식을 검사합니다. Pi가 표준을 어디까지 완화하는지(이름과 디렉터리명 불일치 허용, `description` 없으면 미로딩 등)도 함께 반영합니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-skill-creator
```

같은 이름의 스킬이 `~/.pi/agent/skills/skill-creator` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 설치해야 하는 것

- `python3` (검증 스크립트만, 표준 라이브러리로 동작)
- Pi 공식 문서를 참고하는 단계에서는 pi CLI가 설치돼 있어야 합니다

처음 한 번 설치하는 방법과 동작 확인 순서는 [skills/skill-creator/references/setup.md](skills/skill-creator/references/setup.md)에 있습니다. `python3`가 없으면 에이전트가 검증을 건너뛰고 체크리스트로 수동 점검한 뒤 그 사실을 알려 줍니다.

## 사용 예

```text
사내 위키 요약 스킬 만들어줘
이 스킬이 엉뚱한 요청에도 자꾸 불려와. description 좀 고쳐줘
방금 만든 스킬 형식만 검증해줘
SKILL.md가 너무 길어졌는데 references로 나눠줘
이 스킬 Pi에서 왜 안 불러와지는지 봐줘
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 불러옵니다. 직접 부르려면 `/skill:skill-creator <요청>`을 쓰세요.

## 하지 않는 것

- 권한 상승, 데이터 유출, 위험한 자동화를 돕는 스킬은 만들지 않습니다.
- Claude Code 전용 명령이나 필드(`argument-hint` 등)를 전제로 한 스킬을 쓰지 않습니다. Pi가 읽지 않습니다.
- 평가 작업 공간을 Pi가 스캔하는 스킬 디렉터리 안에 만들지 않습니다. 이름 충돌이 생깁니다.
- 검증 결과를 "통과"로 뭉뚱그리지 않습니다. 경고가 있으면 개수와 내용을 함께 보고합니다.
