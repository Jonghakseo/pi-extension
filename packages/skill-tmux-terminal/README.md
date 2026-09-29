# @ryan_nookpi/pi-skill-tmux-terminal

TUI, REPL, stdin 입력, 선택 메뉴처럼 실제 터미널 화면이 필요한 프로그램을 전용 tmux 서버로 실행하고 화면 캡처와 키 입력으로 조작하는 스킬입니다. 세션은 Pi 세션 ID로 소유권을 나눠 다른 세션의 화면과 섞이지 않습니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-tmux-terminal
```

같은 이름의 스킬이 `~/.pi/agent/skills/tmux-terminal` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 설치해야 하는 것

`tmux`

처음 한 번 설치하는 방법은 [skills/tmux-terminal/references/setup.md](skills/tmux-terminal/references/setup.md)에 있습니다. 스킬도 전제가 빠졌을 때 이 문서를 보고 안내합니다.

## 사용 예

```text
/skill:tmux-terminal python REPL 띄워서 이 식 계산해줘
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 불러오므로, 명시적으로 `/skill:tmux-terminal`을 쓰지 않아도 됩니다.
