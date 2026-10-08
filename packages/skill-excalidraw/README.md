# @ryan_nookpi/pi-skill-excalidraw

플로우차트, 아키텍처도, 시퀀스·상태 다이어그램을 `.excalidraw` 파일로 만들고 실시간 동기화되는 로컬 Excalidraw 창으로 여는 스킬입니다. 에이전트가 파일을 고치면 창에 바로 반영되고, 사용자가 창에서 고친 내용은 같은 파일에 저장됩니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-excalidraw
```

같은 이름의 스킬이 `~/.pi/agent/skills/excalidraw` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 준비해야 하는 것

- Google Chrome (macOS). Linux는 Chrome 또는 Chromium이 PATH에 있으면 됩니다
- Node 18 이상. 패키지에 빌드된 편집기 앱이 들어 있어 추가 빌드는 필요 없습니다

설치 순서와 동작 확인 방법은 [skills/excalidraw/references/setup.md](skills/excalidraw/references/setup.md)에 있습니다. 준비가 덜 된 상태에서 스킬을 부르면 에이전트가 빠진 단계만 짧게 알려 줍니다. macOS 기준으로 검증했습니다.

## 사용 예

```text
로그인 흐름을 플로우차트로 그려줘
이 레포 배포 파이프라인을 아키텍처 다이어그램으로 정리해줘
주문 API 요청 순서를 시퀀스 다이어그램으로 보여줘
방금 그린 다이어그램에서 결제 실패 분기를 추가해줘
docs/flow.mmd에 쓴 mermaid를 Excalidraw로 가져와줘
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 스킬을 불러옵니다. 직접 부르려면 `/skill:excalidraw <요청>`을 쓰세요.

파일은 기본적으로 작업 디렉터리의 `./.diagrams/<주제>.excalidraw`에 만듭니다. 창은 사용자 Chrome 프로필과 분리된 전용 프로필로 뜨고, 연결된 창 없이 30분이 지나면 서버가 스스로 꺼집니다.

## 하지 않는 것

- Windows를 지원하지 않습니다. macOS와 Linux만 동작합니다.
- 창은 로컬 전용입니다. 공유 가능한 URL이나 Excalidraw 클라우드 연동은 없습니다.
- 같은 요소를 사용자와 에이전트가 동시에 고치면 파일 값이 이깁니다. 덮어쓴 내용은 `history` 백업으로 되돌립니다.
- mermaid를 다시 가져오면 그 사이에 손으로 고친 내용은 사라집니다.
- 패키지에 편집기 앱 자산 약 21MB가 함께 들어갑니다. 설치 용량이 작지 않습니다.
