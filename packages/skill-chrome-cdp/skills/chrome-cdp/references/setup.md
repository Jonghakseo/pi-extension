# chrome-cdp 최초 설정

사용자의 실제 Chrome에 붙으려면 세 가지가 필요하다. 모두 한 번만 하면 된다.

## 1. Chrome 144 이상

`chrome://version`에서 버전을 확인한다. 낮으면 `chrome://settings/help`에서 업데이트한다. 설치돼 있지 않으면:

```bash
brew install --cask google-chrome
```

## 2. 원격 디버깅 허용

Chrome 주소창에 `chrome://inspect/#remote-debugging`을 열고 원격 디버깅 토글을 켠다. 이 설정은 Chrome 프로필에 저장된다.

연결할 때마다 Chrome이 Allow 대화상자를 띄운다. 사용자가 직접 눌러야 하며, 연결(데몬 세션)마다 한 번이다.

## 3. `chrome-devtools` CLI

npm 패키지 `chrome-devtools-mcp`(Node 20.19 이상)가 `chrome-devtools` 명령을 제공한다. 둘 중 하나로 전역 설치한다.

```bash
npm install -g chrome-devtools-mcp@latest
# 또는 mise를 쓰는 경우
mise use -g npm:chrome-devtools-mcp@latest
```

확인:

```bash
command -v chrome-devtools && chrome-devtools --version
```

mise로 설치했는데 명령을 못 찾으면 `~/.local/share/mise/shims/chrome-devtools`를 절대 경로로 쓴다.

## raw CDP 모드만 쓸 때

`scripts/cdp.mjs`는 Node만 있으면 된다. 다만 사용자 기본 프로필이 아니라 `--remote-debugging-port`와 별도 `--user-data-dir`로 띄운 Chromium에 붙는다.
