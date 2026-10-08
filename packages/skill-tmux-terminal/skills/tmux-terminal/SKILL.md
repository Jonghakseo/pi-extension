---
name: tmux-terminal
description: "TUI·REPL처럼 화면 확인과 키 입력이 필요한 대화형 터미널을 제어할 때 사용한다."
license: MIT
compatibility: macOS와 Linux에서만 동작한다(Windows는 WSL 안에서 실행). `tmux` 실행 파일이 필요하고 tmux 3.6a에서 검증했다. Node는 Pi 런타임을 그대로 쓴다. `--command`는 기본적으로 `/bin/bash`에서 실행된다.
---

# tmux-terminal

`bash_async`는 유한한 비대화형 작업용이다. 이 helper는 TUI, REPL, stdin, 선택 메뉴처럼 PTY 입력과 화면 캡처가 필요한 경우에만 쓴다. 짧은 동기 `bash` 호출로 이 스크립트를 실행한다.

이 도구는 native overlay, attach view, `/attach`, `/dismiss`, 위젯, reattach UI를 제공하지 않는다.

## 시작 전 확인

스크립트는 Pi가 로드한 이 `SKILL.md`의 절대 경로를 기준으로 실행한다. 현재 프로젝트 cwd에 `skills/tmux-terminal`이 있다고 가정하지 않는다.

```bash
# <loaded-skill-dir>는 이 SKILL.md가 들어 있는 절대 디렉터리다.
SKILL_DIR="<loaded-skill-dir>"
HELPER="$SKILL_DIR/scripts/tmux-terminal.mjs"
test -f "$HELPER"
node "$HELPER" doctor --owner "$PI_SESSION_ID"
```

서브커맨드와 옵션 전체는 `node "$HELPER" help`로 볼 수 있다.

모든 세션은 `PI_SESSION_ID` 또는 명시적 `--owner`가 필요하다. 호출마다 같은 owner를 전달한다. 전용 tmux 서버와 owner 메타데이터가 다른 Pi 세션의 화면과 입력을 격리한다.

## 실패했을 때 사용자에게 할 말

아래에 해당하면 재시도하지 말고 짧게 안내한 뒤 기다린다. 일반 `bash`를 PTY인 것처럼 대신 쓰지 않는다. 설치 절차는 [references/setup.md](references/setup.md)에 있다.

| 증상 | 사용자에게 할 말 |
| --- | --- |
| `doctor`가 `"supported":false` | "`brew install tmux`(Linux는 `apt install tmux`)로 tmux를 설치해 주세요." |
| Windows 네이티브 환경 | "이 스킬은 macOS·Linux에서만 동작합니다. Windows라면 WSL 안에서 Pi를 실행해 주세요." |
| `session_not_found` | 세션이 이미 끝났다. `list`로 남은 세션을 확인하고, 필요하면 `start`로 다시 띄운다. |
| `ownership` | 다른 Pi 세션의 세션이다. 건드리지 않고 자기 owner로 새로 `start`한다. |
| `invalid_key` | 리터럴 문자열을 `send-keys`로 보냈다. `paste`로 바꿔 보낸다. |

## Workflow

### 1. 인터랙티브 프로그램 시작

명령은 `--command` 하나에 원문 그대로 전달한다. helper는 mode `0700` 스크립트에 저장한 뒤 gate를 열어 실행하므로 `;`, `&&`, 파이프, 인용, 줄바꿈이 보존된다.

```bash
node "$HELPER" start --owner "$PI_SESSION_ID" \
  --title "database prompt" \
  --command 'psql -d app'
```

결과 JSON의 `result.session`을 이후 호출에 사용한다. 개발 서버, 빌드, 테스트, headless 유한 명령에는 이 helper를 쓰지 말고 `bash_async`를 사용한다.

### 2. 화면을 확인하고 입력

키를 보내기 전에 항상 capture한다. 커서 위치를 가정하지 말고, `READY`, 메뉴 제목, `>` 같은 안정적인 prompt 텍스트를 찾는다.

```bash
node "$HELPER" capture --owner "$PI_SESSION_ID" --session "$SESSION" --lines 80
node "$HELPER" send-keys --owner "$PI_SESSION_ID" --session "$SESSION" --keys Down,Enter
```

`--lines N`은 화면 **아래쪽부터** N줄을 돌려준다. 화면 밑에 남은 빈 줄은 먼저 버리므로 작은 값을 줘도 최신 출력이 빠지지 않는다. 1~200이며 기본값은 200이다. 전체 화면을 봐야 하는 TUI는 기본값을 쓰고, 마지막 프롬프트 한두 줄만 필요하면 `--lines 5`처럼 줄여 컨텍스트를 아낀다.

`send-keys`는 `Enter`, `Escape`, 화살표, `C-c`, `C-d`, function key 같은 이름 있는 키만 허용한다. 키는 두 가지로 지정한다.

- `--key Enter`: 키 하나. 여러 번 반복해 순서대로 보낼 수 있다.
- `--keys Down,Enter`: 콤마로 구분한 여러 키를 한 번에 보낸다.

일반 문자열이나 비밀번호, 여러 줄 입력은 반드시 `paste`로 전달한다.

```bash
node "$HELPER" paste --owner "$PI_SESSION_ID" --session "$SESSION" --text 'select now();'
node "$HELPER" send-keys --owner "$PI_SESSION_ID" --session "$SESSION" --key Enter
```

긴 텍스트는 stdin 또는 파일로 넘길 수 있다. `paste` 입력은 UTF-8 기준 최대 5 MiB이며, 초과한 `--text`, 파일, stdin은 tmux buffer나 임시 파일을 만들기 전에 거절된다.

```bash
printf 'first line\n둘째 줄\n' | node "$HELPER" paste --owner "$PI_SESSION_ID" --session "$SESSION"
```

### 3. 상태 확인과 정리

`status`는 pane 종료 여부와 종료 상태를, `capture`는 최대 200줄과 5KB의 화면 텍스트를 JSON `text` 필드로 돌려준다.

```bash
node "$HELPER" status --owner "$PI_SESSION_ID" --session "$SESSION"
# 세션 이름을 잃어버렸을 때
node "$HELPER" list --owner "$PI_SESSION_ID"
node "$HELPER" kill --owner "$PI_SESSION_ID" --session "$SESSION"
# 이 작업에서 만든 owner 세션이 남지 않도록 마지막에 실행
node "$HELPER" cleanup --owner "$PI_SESSION_ID"
```

작업에서 만든 세션은 항상 `kill` 또는 `cleanup`한다. `list`와 `cleanup`은 현재 owner의 세션만 대상으로 하며, 다른 owner의 세션을 전역 정리하지 않는다. 이미 사라진 세션을 가리키면 `session_not_found`가 돌아온다.

## Boundaries

- dedicated tmux server만 사용한다. 사용자의 기본 tmux server를 읽거나 죽이지 않는다.
- `capture`, `status`, 입력, `kill`은 정확한 owner 메타데이터를 다시 확인한다.
- owner 검사는 Pi 세션 간 실수 방지 경계다. 같은 OS 사용자가 다른 `--owner`를 사칭하거나 전용 socket에 직접 접근하는 것을 막는 보안 인증 경계는 아니다.
- `--command`는 `/bin/bash`에서 실행된다. 사용자의 zsh 함수나 alias는 적용되지 않으므로 실행 파일 경로나 완전한 명령을 넘긴다. 다른 인터프리터가 필요하면 `--shell /bin/zsh`처럼 절대 경로로 지정한다.
- macOS와 Linux에서만 동작한다. Windows 네이티브에는 tmux가 없으므로 WSL 안에서 실행해야 한다.
- 이 helper는 큐, 자동 완료 알림, 영속 로그, 서버 관리 기능이 없다.
- `TMUX_BIN=/path/to/tmux`로 테스트용 binary를 지정할 수 있다.
