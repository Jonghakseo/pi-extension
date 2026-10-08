# chrome-cdp 최초 설정

사용자의 실제 Chrome에 붙으려면 아래 세 가지가 필요하다. 모두 한 번만 하면 된다. 이 문서는 macOS 기준이다. Linux와 Windows도 Chrome 토글과 CLI 설치 방법은 같고, Chrome 설치 명령과 탭 URL fallback(AppleScript)만 다르다.

## 1. Chrome 144 이상

`chrome://version`에서 버전을 확인한다. 144보다 낮으면 `chrome://settings/help`에서 업데이트한다. 설치돼 있지 않으면:

```bash
brew install --cask google-chrome
```

## 2. 원격 디버깅 허용

Chrome 주소창에 `chrome://inspect/#remote-debugging`을 열고 원격 디버깅 토글을 켠다. 설정은 Chrome 프로필에 저장되므로 Chrome을 다시 켜도 유지된다.

토글을 켜도 아무나 바로 붙을 수 있는 것은 아니다. 에이전트가 연결할 때마다 Chrome이 Allow 대화상자를 띄우고, 사용자가 직접 눌러야 연결된다. 다른 Chrome 창이나 다른 데스크톱(Space)에 뜰 수 있으니 창이 안 보이면 그쪽을 확인한다.

## 3. `chrome-devtools` CLI

npm 패키지 `chrome-devtools-mcp`가 `chrome-devtools` 명령을 제공한다. Node 20.19 이상이 필요하다. 둘 중 하나로 전역 설치한다.

```bash
npm install -g chrome-devtools-mcp@latest
# 또는 mise를 쓰는 경우
mise use -g npm:chrome-devtools-mcp@latest
```

mise로 설치했는데 명령을 못 찾으면 `~/.local/share/mise/shims/chrome-devtools`를 절대 경로로 쓴다.

## 4. 연결 확인

설치가 끝나면 한 번 실제로 붙어 본다.

```bash
chrome-devtools start --autoConnect      # Chrome에 Allow 창이 뜨면 누른다
chrome-devtools list_pages               # 열린 탭 목록이 나오면 성공
chrome-devtools stop                     # 연결 해제
```

`start`가 실패하면 2번 토글이 켜져 있는지, Chrome이 실행 중인지 확인한다. Chrome Beta나 Canary를 쓴다면 `--channel beta`처럼 채널을 지정한다.

## raw CDP 모드만 쓸 때

`scripts/cdp.mjs`는 CLI 없이 Node 22 이상만 있으면 된다(내장 WebSocket 사용). 위 2번 토글을 켜면 Chrome이 프로필 디렉터리에 `DevToolsActivePort` 파일을 만들고, 스크립트가 이 파일로 연결한다. 확인:

```bash
node --version                           # v22 이상
node <스킬 디렉터리>/scripts/cdp.mjs list   # Allow를 누르면 탭 목록 출력
```

`--remote-debugging-port`와 별도 `--user-data-dir`로 띄운 Chromium에 붙으려면 `CDP_PORT_FILE=<user-data-dir>/DevToolsActivePort`를 지정한다.
