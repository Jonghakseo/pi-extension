# @ryan_nookpi/pi-skill-excalidraw

플로우차트, 아키텍처도, 시퀀스·상태 다이어그램을 `.excalidraw` 파일로 만들고 실시간 동기화되는 로컬 Excalidraw 창으로 여는 스킬입니다. 에이전트가 파일을 고치면 창에 바로 반영되고, 사용자가 창에서 고친 내용은 같은 파일에 저장됩니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-excalidraw
```

같은 이름의 스킬이 `~/.pi/agent/skills/excalidraw` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 설치해야 하는 것

Google Chrome (macOS). Linux는 Chrome 또는 Chromium

처음 한 번 설치하는 방법은 [skills/excalidraw/references/setup.md](skills/excalidraw/references/setup.md)에 있습니다. 스킬도 전제가 빠졌을 때 이 문서를 보고 안내합니다.

## 사용 예

```text
/skill:excalidraw 로그인 흐름을 그려줘
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 불러오므로, 명시적으로 `/skill:excalidraw`을 쓰지 않아도 됩니다.
