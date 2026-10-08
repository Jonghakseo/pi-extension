# @ryan_nookpi/pi-skill-tmux-terminal

TUI, REPL, stdin 입력, 선택 메뉴처럼 실제 터미널 화면이 필요한 프로그램을 전용 tmux 서버로 실행하고 화면 캡처와 키 입력으로 조작하는 스킬입니다. 세션은 Pi 세션 ID로 소유권을 나눠 다른 세션의 화면과 섞이지 않습니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-tmux-terminal
```

같은 이름의 스킬이 `~/.pi/agent/skills/tmux-terminal` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 설치해야 하는 것

- macOS 또는 Linux (Windows는 WSL 안에서 실행)
- `tmux` (`brew install tmux`, `apt install tmux`)

Node는 Pi가 쓰는 런타임을 그대로 사용하므로 따로 설치하지 않습니다. 설치와 동작 확인 순서는 [skills/tmux-terminal/references/setup.md](skills/tmux-terminal/references/setup.md)에 있습니다. tmux가 없는 상태에서 스킬을 부르면 에이전트가 설치 명령만 짧게 알려 줍니다. macOS의 tmux 3.6a에서 검증했습니다.

## 사용 예

```text
python REPL 띄워서 이 식 계산해줘
psql 붙어서 이 테이블 스키마 확인해줘
npm create vite 실행하고 React + TypeScript 골라줘
ssh로 들어가서 비밀번호 입력하고 로그 꼬리 좀 봐줘
top 화면 캡처해서 CPU 많이 쓰는 프로세스 알려줘
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 불러옵니다. 직접 부르려면 `/skill:tmux-terminal <요청>`을 쓰세요.

## 하지 않는 것

- 사용자의 기본 tmux 서버와 `~/.tmux.conf`는 읽지도 않고 건드리지도 않습니다. 전용 소켓만 씁니다.
- 다른 Pi 세션이 만든 세션은 들여다보거나 종료하지 않습니다.
- 개발 서버, 빌드, 테스트처럼 화면 입력이 필요 없는 명령에는 쓰지 않습니다. 그쪽은 `bash_async`가 맞습니다.
- 작업이 끝나면 세션을 남기지 않습니다. 큐, 완료 알림, 영속 로그 같은 기능은 없습니다.
