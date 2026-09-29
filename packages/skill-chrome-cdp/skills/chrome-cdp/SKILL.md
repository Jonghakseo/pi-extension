---
name: chrome-cdp
description: "사용자의 실제 Chrome 세션(로그인 상태·열린 탭)을 검사·조작할 때 사용한다. '내 브라우저에서 확인', '열린 탭 봐줘', 로그인 상태에서만 재현되는 프론트엔드 이슈 조사, 인증된 dev/admin 화면 검증, 임의 raw CDP 메서드 호출이 필요할 때 적용한다. 사용자 세션이 필요 없는 격리 브라우저 자동화에는 쓰지 않는다."
license: MIT (see LICENSE)
compatibility: Requires the chrome-devtools CLI (chrome-devtools-mcp >= 1.0, installed globally via npm or mise) and Chrome 144+ with remote debugging enabled for auto-connect. Raw CDP mode requires a Chromium launched with a custom debugging profile.
---

# Chrome CDP

사용자의 실제 Chrome에 연결해 증거를 수집하거나 조작한다. 두 가지 모드가 있다:

1. **공식 `chrome-devtools` CLI + auto-connect (주력)**: Chrome 144+ 실제 프로필에 연결. 분석 도구(snapshot, network, console, screenshot, evaluate_script) 내장.
2. **`scripts/cdp.mjs` raw CDP (특수 목적)**: 임의 CDP 메서드 직접 호출(`evalraw`)이 필요하거나, 커스텀 디버깅 프로필로 띄운 Chromium을 다룰 때.

## 동의 게이트

- 사용자가 자기 브라우저 검사·조작을 요청했거나 명시적으로 동의했을 때만 연결한다. 그 외에는 사용자의 브라우저에 붙거나, 탭을 나열하거나, 스크린샷을 찍지 않는다.
- auto-connect 연결 시 Chrome이 **Allow 대화상자**를 띄운다. 사용자가 클릭해야 하며, 우회·시뮬레이션하지 않는다. Allow는 연결(데몬 세션)당 1회다.

## Auto-connect workflow

### 0. 전제 확인

- CLI: `command -v chrome-devtools`. 없으면 mise shim `~/.local/share/mise/shims/chrome-devtools`도 확인한다. 둘 다 없으면 연결을 시도하지 말고 [references/setup.md](references/setup.md)의 최초 설정을 사용자에게 안내한다.
- 사용자 Chrome이 144+이고 `chrome://inspect/#remote-debugging` 토글이 켜져 있어야 한다. 연결 실패 시 이 토글부터 사용자에게 확인한다. 방법은 [references/setup.md](references/setup.md)에 있다.
- `chrome-devtools status`로 기존 데몬 확인. **데몬은 전역 단일**이라 다른 세션이나 에이전트가 쓰고 있을 수 있다. `start`는 재시작이므로, 다른 작업이 데몬을 쓰는 중이면 끝날 때까지 기다리거나 사용자에게 확인한다.

### 1. 연결

```bash
CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 chrome-devtools start --autoConnect --redactNetworkHeaders
```

사용자에게 "Chrome에 Allow 창이 뜨면 클릭해달라"고 한 줄로 안내한다.

### 2. 조사

```bash
chrome-devtools list_pages                                        # 페이지 목록, [selected] 표시
chrome-devtools select_page <pageId>                              # 대상 페이지 선택
chrome-devtools take_snapshot <pageId>                            # UID 포함 접근성 스냅샷
chrome-devtools evaluate_script "() => document.title" --pageId <pageId>
chrome-devtools take_screenshot <pageId> --filePath <path>
chrome-devtools list_network_requests <pageId>                    # 필터 가능 옵션은 --help 확인
chrome-devtools list_console_messages <pageId>
chrome-devtools click <pageId> <uid>                              # take_snapshot의 UID 사용
```

- 페이지 조작 전 `take_snapshot`으로 UID를 확보한다. UID가 사라지면 DOM이 바뀐 것이니 재스냅샷한다.
- 명령 표면이 불확실하면 `chrome-devtools <tool> --help`를 먼저 읽는다. 프로그램 파싱이 필요할 때만 `--output-format=json`.
- `wait_for`·`fill_form`은 CLI에 없다. 대기는 `evaluate_script` 폴링으로 처리한다.

### 3. 정리

증거 수집이 끝나면 기본적으로 `chrome-devtools stop`으로 연결을 끊는다 (연결 유지 = 에이전트가 계속 접근 가능한 상태이므로). 사용자가 이어서 쓸 예정이라고 하면 유지하고, 유지 중이라는 사실을 보고에 남긴다. stop 후 재연결에는 Allow 재클릭이 필요하다.

## Raw CDP 모드 (`scripts/cdp.mjs`)

`DevToolsActivePort` 파일을 노출하는 Chromium(커스텀 디버깅 프로필로 실행된 경우) 전용. auto-connect 토글 방식(144+)에서는 discovery가 없어 동작하지 않는다. 강점은 `evalraw <method> [json]`으로 **임의 CDP 메서드**를 직접 호출할 수 있다는 것.

```bash
scripts/cdp.mjs list
scripts/cdp.mjs shot <target> [file]
scripts/cdp.mjs snap <target>
scripts/cdp.mjs eval <target> <expression>
scripts/cdp.mjs html <target> [selector]
scripts/cdp.mjs nav <target> <url>
scripts/cdp.mjs net <target>
scripts/cdp.mjs click <target> <selector>
scripts/cdp.mjs clickxy <target> <x> <y>
scripts/cdp.mjs type <target> <text>
scripts/cdp.mjs loadall <target> <selector> [ms]
scripts/cdp.mjs evalraw <target> <method> [json]
scripts/cdp.mjs open [url]
scripts/cdp.mjs stop [target]
```

주의:

- DOM이 바뀔 수 있으면 호출 간 `querySelectorAll(...)[i]` 인덱스 선택을 피하고, 한 번의 `eval`로 모아서 수집하거나 안정 셀렉터를 쓴다.
- `shot`은 네이티브 해상도 픽셀, CDP 입력 좌표는 CSS 픽셀이다. 이미지 좌표를 DPR로 나눈다.
- cross-origin iframe 텍스트 입력은 `eval` 대신 `type`을 쓴다.

## 출력 위생 (두 모드 공통)

- 실제 프로필 연결은 로그인 상태·탭·확장·쿠키를 그대로 상속한다. 모든 출력을 민감정보로 취급한다.
- 쿠키, Authorization 헤더, 세션 토큰, localStorage 값, 무관한 탭 내용을 출력하지 않는다.
- `--redactNetworkHeaders`는 일부 헤더만 가린다. 응답 바디와 페이지 내용은 여전히 민감할 수 있으니 작업에 필요한 최소한만 수집한다.
- 무관한 탭·스토리지·요청 바디를 열람하지 않는다. 증거가 충분해지면 멈춘다.
- 디버거 입력이나 타이밍 조작을 자동화 탐지 회피 수단으로 쓰지 않는다.

## Fallback: 탭 URL 목록만 필요할 때

CDP 연결이 불가능하고(토글 꺼짐, Allow 거부 등) 열린 탭 URL 목록만 필요하면 짧은 timeout을 둔 AppleScript를 쓴다. 화면만 보고 URL을 추측하지 않는다.

```bash
timeout 5 osascript -e 'tell application "Google Chrome" to get URL of tabs of windows'
```

이 경로는 URL만 줌니다. DOM·네트워크·콘솔이 필요하면 auto-connect로 돌아간다.

## Troubleshooting

- 연결 실패·행: `chrome-devtools stop` 후 재시도. 자세한 로그는 `DEBUG=* chrome-devtools <tool>`.
- Allow 창이 안 뜸: Chrome 버전(144+), 채널(stable 기본, 다른 채널은 `--channel`), `chrome://inspect/#remote-debugging` 토글 상태 확인.
- 데몬이 격리 브라우저 상태로 떠 있음: 해당 작업 종료 후 `chrome-devtools start --autoConnect`로 재시작 (start = 재시작).
- raw 모드에서 `No DevToolsActivePort found`: 144+ 토글 방식 크롬이다. auto-connect 모드를 쓴다.
