---
name: chrome-cdp
description: "로그인 상태와 열린 탭이 있는 사용자의 실제 Chrome 세션을 검사·조작할 때 사용한다."
license: MIT (see LICENSE)
compatibility: macOS 기준으로 검증했다. Requires Chrome 144+ with the chrome://inspect/#remote-debugging toggle on. Main mode needs the chrome-devtools CLI (chrome-devtools-mcp, verified on 1.8.0, Node 20.19+). Raw CDP mode needs Node 22+.
---

# Chrome CDP

사용자의 실제 Chrome에 연결해 증거를 수집하거나 조작한다. 모드는 두 가지다.

1. **공식 `chrome-devtools` CLI + auto-connect (주력)**: 스냅샷, 네트워크, 콘솔, 스크린샷, 스크립트 실행, 입력 도구가 들어 있다.
2. **`scripts/cdp.mjs` raw CDP (특수 목적)**: 임의 CDP 메서드를 직접 호출(`evalraw`)해야 하거나 CLI를 설치할 수 없을 때 쓴다.

두 모드 모두 같은 `chrome://inspect/#remote-debugging` 토글을 쓰고, 연결할 때 Chrome이 Allow 대화상자를 띄운다.

## 동의 게이트

- 사용자가 자기 브라우저를 검사·조작해 달라고 요청했거나 명시적으로 동의했을 때만 연결한다. 그 외에는 브라우저에 붙지 않고, 탭을 나열하지 않고, 스크린샷을 찍지 않는다.
- Allow 대화상자는 사용자가 직접 눌러야 한다. 우회하거나 시뮬레이션하지 않는다. CLI 모드는 데몬 세션마다 한 번, raw 모드는 탭 데몬마다 한 번 뜬다.

## 처음 쓰는 사용자 대응

전제가 빠졌으면 연결을 계속 시도하지 말고, 아래 표에서 해당하는 메시지만 짧게 전한 뒤 사용자가 조치할 때까지 기다린다. setup 문서 전체를 붙여 넣지 않는다. 자세한 절차는 [references/setup.md](references/setup.md)에 있다.

| 증상 | 사용자에게 할 말 |
| --- | --- |
| `chrome-devtools` 명령이 없음 | "`npm install -g chrome-devtools-mcp@latest`로 CLI를 설치해 주세요 (Node 20.19+)." |
| Chrome 143 이하 | "`chrome://settings/help`에서 Chrome을 144 이상으로 업데이트해 주세요." |
| `start`가 실패하거나 Allow 창이 안 뜸 | "Chrome 주소창에 `chrome://inspect/#remote-debugging`을 열고 원격 디버깅 토글을 켜 주세요." |
| Allow 창을 사용자가 못 찾음 | "다른 Chrome 창이나 다른 데스크톱(Space)에 Allow 창이 떠 있을 수 있어요. Chrome 창을 확인해 주세요." |
| 사용자가 Allow를 거절함 | 재시도하지 않는다. 다시 연결할지 사용자에게 묻는다. |

Allow를 기다리는 동안 같은 명령을 반복 실행하지 않는다. 한 번 안내하고 결과를 기다린다.

## Auto-connect workflow

### 0. 전제 확인

- CLI: `command -v chrome-devtools`. 없으면 mise shim `~/.local/share/mise/shims/chrome-devtools`도 확인한다. 둘 다 없으면 위 표대로 안내한다.
- `chrome-devtools status`로 기존 데몬을 확인한다. **데몬은 전역에 하나뿐**이라 다른 세션이나 에이전트가 쓰고 있을 수 있다. `start`는 재시작이므로, 다른 작업이 데몬을 쓰는 중이면 끝날 때까지 기다리거나 사용자에게 확인한다.
- 새 버전이 있으면 CLI가 `Update available ...` 안내를 출력에 섞는다. 출력을 파싱할 때는 이 줄을 무시한다.

### 1. 연결

```bash
CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 chrome-devtools start --autoConnect --redactNetworkHeaders
```

사용자에게 "Chrome에 Allow 창이 뜨면 눌러 주세요"라고 한 줄로 안내한다. stable이 아닌 채널(Beta, Canary 등)을 쓰는 사용자라면 `--channel`을 붙인다.

### 2. 조사

```bash
chrome-devtools list_pages                                        # 페이지 목록, [selected] 표시
chrome-devtools select_page <pageId>                              # 대상 페이지 선택
chrome-devtools take_snapshot <pageId>                            # UID가 포함된 접근성 스냅샷
chrome-devtools evaluate_script "() => document.title" --pageId <pageId>
chrome-devtools take_screenshot <pageId> --filePath <path>
chrome-devtools list_network_requests <pageId>                    # 필터 옵션은 --help 확인
chrome-devtools list_console_messages <pageId>
```

조작:

```bash
chrome-devtools click <pageId> <uid>                              # take_snapshot의 UID 사용
chrome-devtools fill <pageId> <uid> <value>                       # input, textarea, select
chrome-devtools type_text <pageId> <text>                         # 이미 포커스된 입력에 키보드 입력
chrome-devtools press_key <pageId> <key>                          # 예: Enter, Control+A
chrome-devtools navigate_page <pageId> --url <url>                # --type back|forward|reload도 가능
chrome-devtools new_page <url>
```

- 페이지를 조작하기 전에 `take_snapshot`으로 UID를 확보한다. UID가 사라졌다면 DOM이 바뀐 것이니 다시 스냅샷을 찍는다.
- 명령 사용법이 불확실하면 `chrome-devtools <tool> --help`를 먼저 읽는다. 프로그램으로 파싱해야 할 때만 `--output-format=json`을 쓴다.
- `wait_for`와 `fill_form`은 CLI에 없다. 대기는 `evaluate_script` 폴링으로, 여러 필드 입력은 `fill`을 필드마다 호출해 처리한다.

### 3. 정리

증거 수집이 끝나면 기본적으로 `chrome-devtools stop`으로 연결을 끊는다. 연결을 유지하면 에이전트가 계속 브라우저에 접근할 수 있는 상태로 남기 때문이다. 사용자가 이어서 쓰겠다고 하면 유지하고, 유지 중이라는 사실을 보고에 남긴다. stop 후 다시 연결하려면 Allow를 또 눌러야 한다.

## Raw CDP 모드 (`scripts/cdp.mjs`)

Chrome이 프로필 디렉터리에 쓰는 `DevToolsActivePort` 파일로 연결한다. 위 토글을 켜면 실제 프로필에도 이 파일이 생기므로 토글 방식에서도 동작한다. 커스텀 디버깅 프로필은 `CDP_PORT_FILE=<경로>/DevToolsActivePort`로 지정한다. Node 22+가 필요하다(내장 WebSocket 사용).

`scripts/cdp.mjs`는 이 SKILL.md가 있는 디렉터리 기준 경로다. 현재 작업 디렉터리가 아니라 스킬 디렉터리를 붙인 절대 경로로 실행한다.

```bash
scripts/cdp.mjs list                       # 탭 목록 (targetId 앞 8자리 사용)
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

- 탭마다 데몬이 따로 뜨고, 처음 붙는 탭마다 Allow 창이 뜬다. 데몬은 20분 동안 쓰지 않으면 스스로 종료된다. 작업이 끝나면 `stop`으로 정리한다.
- DOM이 바뀔 수 있으면 호출 사이에 `querySelectorAll(...)[i]` 같은 인덱스 선택을 피한다. 한 번의 `eval`로 모아서 수집하거나 안정적인 셀렉터를 쓴다.
- `shot`은 네이티브 해상도 픽셀로 찍히고 CDP 입력 좌표는 CSS 픽셀이다. 이미지 좌표를 DPR로 나눠서 쓴다.
- cross-origin iframe에 텍스트를 입력할 때는 `eval` 대신 `type`을 쓴다.

## 출력 위생 (두 모드 공통)

- 실제 프로필에 연결하면 로그인 상태, 탭, 확장, 쿠키를 그대로 물려받는다. 모든 출력을 민감정보로 취급한다.
- 쿠키, Authorization 헤더, 세션 토큰, localStorage 값, 작업과 무관한 탭 내용을 출력하지 않는다.
- `--redactNetworkHeaders`는 일부 헤더만 가린다. 응답 바디와 페이지 내용은 여전히 민감할 수 있으니 작업에 필요한 최소한만 수집한다.
- 무관한 탭, 스토리지, 요청 바디를 열어 보지 않는다. 증거가 충분해지면 멈춘다.
- 디버거 입력이나 타이밍 조작을 자동화 탐지 회피 수단으로 쓰지 않는다.

## Fallback: 탭 URL 목록만 필요할 때 (macOS)

CDP 연결이 불가능하고(토글 꺼짐, Allow 거부 등) 열린 탭 URL 목록만 필요하면 AppleScript를 쓴다. macOS에는 기본 `timeout` 명령이 없으므로 `perl`의 `alarm`으로 5초 제한을 건다. 화면만 보고 URL을 추측하지 않는다.

```bash
perl -e 'alarm 5; exec @ARGV' osascript -e 'tell application "Google Chrome" to get URL of tabs of windows'
```

이 경로로는 URL만 얻을 수 있다. DOM, 네트워크, 콘솔이 필요하면 auto-connect로 돌아간다. 처음 실행하면 macOS가 터미널의 Chrome 제어 권한(자동화)을 물을 수 있다. 이 창도 사용자가 직접 눌러야 한다.

## Troubleshooting

- 연결 실패나 응답 없음: `chrome-devtools stop` 후 다시 시도한다. 자세한 로그는 `DEBUG=* chrome-devtools <tool>`로 본다.
- Allow 창이 안 뜸: Chrome 버전(144+), 채널(기본 stable, 다른 채널은 `--channel`), `chrome://inspect/#remote-debugging` 토글 상태를 확인한다.
- 데몬이 격리 브라우저 상태로 떠 있음: 해당 작업이 끝난 뒤 `chrome-devtools start --autoConnect`로 재시작한다(start = 재시작).
- raw 모드에서 `No DevToolsActivePort found`: 토글이 꺼져 있거나 Chrome이 실행 중이 아니다. 토글을 켜거나, 커스텀 프로필이면 `CDP_PORT_FILE`을 지정한다.
- raw 모드에서 `requires Node 22+`: Node를 올리거나 CLI 모드를 쓴다.
