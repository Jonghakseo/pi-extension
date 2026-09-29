# @ryan_nookpi/pi-skill-skill-creator

Pi 스킬을 만들고 고치고 검증하는 스킬입니다. `SKILL.md` frontmatter, description 트리거, `references/`·`scripts/` 분리, 작은 eval 설계를 안내하고 `validate_skill.py`로 형식을 검사합니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-skill-creator
```

같은 이름의 스킬이 `~/.pi/agent/skills/skill-creator` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 설치해야 하는 것

`python3` (검증 스크립트만)

처음 한 번 설치하는 방법은 [skills/skill-creator/references/setup.md](skills/skill-creator/references/setup.md)에 있습니다. 스킬도 전제가 빠졌을 때 이 문서를 보고 안내합니다.

## 사용 예

```text
/skill:skill-creator 사내 위키 요약 스킬 만들어줘
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 불러오므로, 명시적으로 `/skill:skill-creator`을 쓰지 않아도 됩니다.
