# tmux-terminal 최초 설정

helper는 전용 tmux 서버를 띄워 PTY 화면을 캡처하고 키를 보낸다. `tmux` 실행 파일이 필요하다. Node는 Pi가 이미 쓰고 있으므로 따로 설치하지 않는다.

macOS와 Linux에서만 동작한다. Windows 네이티브에는 tmux가 없으므로 WSL 안에서 Pi를 실행한 뒤 아래 Linux 절차를 따른다.

## 1. 확인

스크립트는 스킬 디렉터리 기준 절대 경로로 실행한다.

```bash
node "<이 스킬 디렉터리>/scripts/tmux-terminal.mjs" doctor --owner "$PI_SESSION_ID"
```

`"ok":true`가 나오면 설정할 것이 없다. 3번으로 넘어간다.

## 2. 설치 (1회)

```bash
brew install tmux        # macOS
sudo apt install tmux    # Debian, Ubuntu, WSL
sudo dnf install tmux    # Fedora, RHEL
```

Homebrew가 없으면 https://brew.sh 의 설치 명령을 먼저 실행한다. 설치 뒤 1번 `doctor`를 다시 실행한다.

## 3. 동작 확인

실제로 세션을 띄워 화면이 읽히는지 한 번 확인한다. `HELPER`와 `OWNER`를 각자 값으로 바꾼다.

```bash
HELPER="<이 스킬 디렉터리>/scripts/tmux-terminal.mjs"
OWNER="${PI_SESSION_ID:-setup-check}"

node "$HELPER" start --owner "$OWNER" --title setup-check --command 'python3 -q'
# 위 출력의 result.session 값을 SESSION에 넣는다
node "$HELPER" paste   --owner "$OWNER" --session "$SESSION" --text '1+1'
node "$HELPER" send-keys --owner "$OWNER" --session "$SESSION" --key Enter
node "$HELPER" capture --owner "$OWNER" --session "$SESSION" --lines 5
node "$HELPER" cleanup --owner "$OWNER"
```

`capture`의 `text`에 `>>> 1+1`과 `2`가 보이면 정상이다. 마지막 `cleanup`까지 실행해 세션을 남기지 않는다.

이 helper는 사용자의 기존 tmux 세션이나 `~/.tmux.conf`와 섞이지 않도록 별도 소켓을 쓴다. 서브커맨드와 옵션 전체는 `node "$HELPER" help`로 볼 수 있다.
