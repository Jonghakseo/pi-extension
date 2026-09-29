# tmux-terminal 최초 설정

helper는 전용 tmux 서버를 띄워 PTY 화면을 캡처하고 키를 보낸다. `tmux` 실행 파일이 필요하다. Node는 Pi가 이미 쓰고 있으므로 따로 설치하지 않는다.

## 확인

```bash
node "<이 스킬 디렉터리>/scripts/tmux-terminal.mjs" doctor --owner "$PI_SESSION_ID"
```

`"ok":true`가 나오면 설정할 것이 없다.

## 설치 (1회)

```bash
brew install tmux
```

Homebrew가 없으면 https://brew.sh 의 설치 명령을 먼저 실행한다. Linux는 배포판 패키지(`apt install tmux`, `dnf install tmux`)를 쓴다.

설치 뒤 위 `doctor`를 다시 실행한다. 이 helper는 사용자의 기존 tmux 세션이나 `~/.tmux.conf`와 섞이지 않도록 별도 소켓을 쓴다.
