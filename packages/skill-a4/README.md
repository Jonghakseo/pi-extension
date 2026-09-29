# @ryan_nookpi/pi-skill-a4

Markdown 문서를 내용은 그대로 두고 A4 인쇄용 Microsoft Word(`.docx`)로 바꾸는 스킬입니다. 요약·번역·재배열 없이 제목 구조, 목록, 표, 인용, 코드 블록을 보존하고, 결과를 검사 스크립트로 확인합니다. 글꼴·굵기·크기 제약도 지정할 수 있습니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-a4
```

같은 이름의 스킬이 `~/.pi/agent/skills/a4` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 설치해야 하는 것

`python3`, `python-docx`

처음 한 번 설치하는 방법은 [skills/a4/references/setup.md](skills/a4/references/setup.md)에 있습니다. 스킬도 전제가 빠졌을 때 이 문서를 보고 안내합니다.

## 사용 예

```text
/skill:a4 proposal.md
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 불러오므로, 명시적으로 `/skill:a4`을 쓰지 않아도 됩니다.
