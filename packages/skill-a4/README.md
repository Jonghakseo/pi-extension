# @ryan_nookpi/pi-skill-a4

Markdown 문서를 내용은 그대로 두고 A4 인쇄용 Microsoft Word(`.docx`)로 바꾸는 스킬입니다. 요약·번역·재배열 없이 제목 구조, 목록, 표, 인용, 코드 블록을 보존하고, 결과를 검사 스크립트로 확인합니다. 글꼴·굵기·크기 제약도 지정할 수 있습니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-a4
```

같은 이름의 스킬이 `~/.pi/agent/skills/a4` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 준비해야 하는 것

- `python3`
- `python-docx` 라이브러리 (`python3 -m pip install --user python-docx`)
- Noto Sans CJK KR 글꼴. 기본 스타일이 쓰는 글꼴인데 macOS에는 없습니다. 없으면 Word가 다른 글꼴로 대체해서 보여 줍니다. `brew install --cask font-noto-sans-cjk-kr`
- Microsoft Word. 최종 결과를 눈으로 확인하거나 PDF로 내보낼 때 씁니다. 변환과 검사 자체는 Word 없이도 됩니다.

설치 순서와 확인 방법은 [skills/a4/references/setup.md](skills/a4/references/setup.md)에 있습니다. 준비가 덜 된 상태에서 스킬을 부르면 에이전트가 빠진 단계만 짧게 알려 줍니다. macOS와 Microsoft Word 기준으로 검증했습니다.

## 사용 예

```text
proposal.md를 A4 워드로 만들어줘
계약서 md를 Pretendard 10.5pt로 A4 워드 문서로 뽑아줘
report.md 변환해서 docs/report-final.docx로 저장해줘
제목은 16pt, 소제목 12pt, 본문 10.5pt로 맞춰서 인쇄용으로 바꿔줘
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 불러옵니다. 직접 부르려면 `/skill:a4 proposal.md`처럼 씁니다. 출력 경로를 말하지 않으면 입력 파일 옆에 `proposal.a4.docx`로 저장합니다.

## 하지 않는 것

- 원문을 요약, 번역, 재배열하지 않고 문구·숫자·날짜·계약 용어도 고치지 않습니다. 레이아웃만 바꿉니다.
- 레거시 바이너리 `.doc`는 만들지 않습니다. `.doc`라고 말해도 `.docx`로 만듭니다.
- HTML은 명시적으로 요청할 때만 만듭니다. 기본 출력은 DOCX입니다.
- 요청한 글꼴이 설치돼 있지 않으면 비슷한 글꼴로 바꿔치지 않고 그대로 알려 줍니다.
