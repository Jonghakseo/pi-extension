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

### 2. 작업할 페이지 정하기

사용자가 진행 상황을 보거나 중간에 이어받을 수 있는 페이지를 고른다. 아래 순서로 판단한다.

1. 사용자가 탭을 지목했거나("이 페이지에서", "지금 보는 탭") 이미 열린 탭에서 이어 하는 작업이면, 그 탭을 그대로 쓴다. 지목한 탭은 보통 이미 앞에 있으니 읽기만 하는 조사는 `select_page <pageId>`로 충분하다. `--bringToFront`는 사용자가 지켜보거나 직접 해야 할 때(핸드오프, 제출 직전 확인, 결과 보여 주기)만 그 시점에 한 번 쓴다. 사용자 포커스를 불필요하게 뺏지 않는다.
2. 새 페이지가 필요하고 사용자가 결과를 보거나 이어받을 수 있으면(로그인, 폼 제출 직전 확인, 결과 화면 보여 주기) 포그라운드로 연다. `new_page <url>`의 기본값이 포그라운드다.
3. 사용자가 다른 일을 하는 동안 텍스트로만 결과를 보고하는 보조 수집(여러 URL 일괄 조회 등)만 `new_page <url> --background`로 열고, 끝나면 닫는다. 백그라운드 탭은 Chrome이 타이머와 입력 처리를 늦춘다(측정: 2초 폴링이 13초, raw 클릭이 0.1초에서 7.7초로 느려졌다). 느리다고 같은 명령을 반복하지 말고, 시간이 중요하면 포그라운드로 연다.

로그인, 2FA, CAPTCHA, 결제 승인처럼 사용자가 직접 해야 하는 단계가 나오면 핸드오프한다. 해당 탭을 `select_page <pageId> --bringToFront`로 앞에 두고, 무엇을 해야 하는지 한 줄로 안내한 뒤 턴을 끝낸다. 사용자가 끝냈다고 하면 같은 pageId에서 스냅샷을 새로 찍고 이어 간다. 우회하거나 대신 입력하지 않는다.

### 3. 조사와 조작

```bash
chrome-devtools list_pages                                        # 페이지 목록, [selected] 표시
chrome-devtools select_page <pageId> [--bringToFront]             # 대상 페이지 선택
chrome-devtools take_snapshot <pageId>                            # UID가 포함된 접근성 스냅샷
chrome-devtools evaluate_script "() => document.title" --pageId <pageId>
chrome-devtools take_screenshot <pageId> --filePath <path>
chrome-devtools list_network_requests <pageId>                    # 필터 옵션은 --help 확인
chrome-devtools list_console_messages <pageId>
```

조작:

```bash
chrome-devtools click <pageId> <uid> [--includeSnapshot]          # take_snapshot의 UID 사용
chrome-devtools fill <pageId> <uid> <value> [--includeSnapshot]   # input, textarea, select
chrome-devtools type_text <pageId> <text>                         # 이미 포커스된 입력에 키보드 입력
chrome-devtools press_key <pageId> <key> [--includeSnapshot]      # 예: Enter, Control+A
chrome-devtools hover <pageId> <uid>
chrome-devtools drag <pageId> <from_uid> <to_uid>
chrome-devtools navigate_page <pageId> --url <url>                # --type back|forward|reload도 가능
chrome-devtools new_page <url> [--background]
chrome-devtools handle_dialog <pageId> accept|dismiss [--promptText <text>]
chrome-devtools close_page <pageId>
```

- 페이지를 조작하기 전에 `take_snapshot`으로 UID를 확보한다. UID가 사라졌다면 DOM이 바뀐 것이니 다시 스냅샷을 찍는다.
- 명령 사용법이 불확실하면 `chrome-devtools <tool> --help`를 먼저 읽는다. 프로그램으로 파싱해야 할 때만 `--output-format=json`을 쓴다.
- `wait_for`와 `fill_form`은 CLI에 없다. 여러 필드 입력은 `fill`을 필드마다 호출하고, 대기는 아래 "대기" 항목대로 처리한다.
- 프로필이 여러 개 열려 있으면 `list_pages`는 모든 프로필의 탭을 섞어 보여 주고, `new_page`는 프로필을 지정할 수 없어 마지막으로 포커스된 창에 탭을 연다. 특정 프로필에 열려면 그 프로필로 확인된 기존 탭에서 `chrome-devtools evaluate_script "() => { window.open('<url>', '_blank'); return 1 }" --pageId <pageId>`를 실행한다.
- 탭을 조작하거나 "회사/개인 탭"이라고 보고하기 전에 페이지의 로그인 이메일, 계정 도메인, 창 제목(`... - Chrome - <프로필명>`)으로 프로필을 확인한다. 확인할 수 없으면 어느 프로필 창인지 사용자에게 한 줄로 묻는다.
- cross-origin iframe 안은 페이지 컨텍스트의 `evaluate_script`로 접근할 수 없다. `take_snapshot`에서 얻은 iframe 내부 요소 UID를 `--args`로 넘기면 함수가 그 요소의 프레임에서 실행된다. 예: `chrome-devtools evaluate_script "(el) => el.ownerDocument.defaultView.location.href" --pageId <pageId> --args <uid>`

#### 호출 수 줄이기

- 조작 명령에 `--includeSnapshot`을 붙여 결과 스냅샷을 같은 호출로 받고, 다음 대상 UID를 그 스냅샷에서 고른다. 중간 결과가 다음 판단을 바꾸지 않는 연속 조작(필드 여러 개 `fill` 등)은 마지막 명령에만 붙인다.
- 값 여러 개를 읽을 때는 `evaluate_script` 한 번으로 모은다. 읽기만 하는 스크립트는 `--waitForStableDom=false`를 붙여 DOM 안정화 대기를 건너뛴다.
- 다음 행동을 고르는 데 필요한 가장 싼 관찰만 한다. 구조와 조작 대상은 스냅샷, 시각 확인은 스크린샷으로 보고, 둘을 기본으로 같이 찍지 않는다.
- 조작 결과가 기대와 다르면 현재 상태를 먼저 관찰하고 원인을 판단한다. 같은 명령을 그대로 반복하거나 곧바로 좌표 클릭이나 raw CDP로 넘어가지 않는다.
- 요청한 결과가 화면에 확인되면 멈춘다. 같은 결과를 다른 경로로 다시 확인하지 않는다.

#### 대기, 팝업, 다이얼로그

- 고정 시간 sleep 대신 관찰 가능한 조건을 기다린다. 제한 시간이 있는 폴링을 `evaluate_script` 한 번 안에서 돌린다. 백그라운드 탭에서는 타이머가 느려져 폴링이 늘어진다. 클릭이 페이지 이동을 일으키면 실행 컨텍스트가 사라져 폴링이 실패하므로, 이동 뒤 조건은 다음 호출에서 확인한다.

  ```bash
  chrome-devtools evaluate_script "async () => { const end = Date.now() + 10000; while (Date.now() < end) { if (document.querySelector('#result')) return true; await new Promise(r => setTimeout(r, 200)); } return false; }" --pageId <pageId> --waitForStableDom=false
  ```

- 새 탭을 여는 클릭(`target=_blank`, `window.open`)은 클릭 전 `list_pages` 결과를 기억해 두고, 클릭 후 다시 `list_pages`로 비교해 새 pageId를 찾는다. 선택된 페이지가 새 탭으로 바뀌었다고 가정하지 않는다.
- `evaluate_script`는 실행 중 뜬 alert/confirm/prompt를 **기본으로 accept**한다. 버튼 클릭처럼 부작용이 생길 수 있는 스크립트는 `--dialogAction dismiss`를 붙이고, 다이얼로그 내용을 확인한 뒤 결정한다.
- 조작 뒤 다이얼로그가 열려 있으면 `handle_dialog <pageId> accept|dismiss`로 먼저 처리한다. 삭제, 결제, 전송처럼 되돌릴 수 없는 확인 창은 사용자가 요청한 범위 안일 때만 accept한다.
- `navigate_page`는 beforeunload(저장하지 않은 변경 경고)를 **기본으로 accept**한다. 사용자가 입력하던 탭에서 이동하면 그 내용이 사라진다. 사용자 탭에서 이동해야 하면 `--handleBeforeUnload dismiss`를 붙이거나 먼저 묻는다.

### 4. 정리

- 연결 전부터 열려 있던 탭과 사용자가 연 탭은 사용자 것이다. 닫지 않는다.
- 에이전트가 `new_page`로 연 탭은 pageId를 기록해 두고, 끝나면 `close_page`로 닫는다. 사용자가 볼 결과 탭과 핸드오프한 탭은 남기고, 남긴 탭을 보고에 적는다.
- 증거 수집이 끝나면 기본적으로 `chrome-devtools stop`으로 연결을 끊는다. 연결을 유지하면 에이전트가 계속 브라우저에 접근할 수 있는 상태로 남기 때문이다. 사용자가 이어서 쓰겠다고 하면 유지하고, 유지 중이라는 사실을 보고에 남긴다. stop 후 다시 연결하려면 Allow를 또 눌러야 한다.

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

- 탭마다 데몬이 따로 뜨고, 처음 붙는 탭마다 Allow 창이 뜬다. 데몬은 20분 동안 쓰지 않으면 스스로 종료된다. 작업이 끝나면 `stop`으로 정리하고, `open`으로 연 탭은 `evalraw <target> Page.close`로 닫는다.
- `eval`, `click`, `clickxy`, `type` 도중 JS 다이얼로그가 뜨면 15초를 기다리지 않고 바로 반환하며 다이얼로그 내용을 알려 준다. 다이얼로그가 열려 있는 동안 `evalraw`, `list`, `stop`을 뺀 모든 페이지 명령(`snap`, `shot`, `nav`, `html`, `net`, `loadall` 포함)이 즉시 실패한다. `evalraw <target> Page.handleJavaScriptDialog '{"accept":false}'`로 닫으면 풀린다(accept 기준은 CLI 모드와 같다).
- 클릭이 다이얼로그를 만났을 때 결과가 둘로 갈린다. 입력을 보내기 **전에** 다이얼로그가 떴으면 에러로 보고하고 클릭은 수행하지 않으며 나중에도 보내지 않는다. 다이얼로그를 처리한 뒤 페이지 상태를 보고 다시 시도한다. 입력을 보낸 **뒤에** 떴으면 성공으로 보고하니 같은 클릭을 반복하지 않는다.
- 탭 데몬이 붙기 전부터 떠 있던 다이얼로그는 raw 모드로 닫을 수 없다. 먼저 사용자에게 Chrome에서 닫아 달라고 요청한다.
- 저장하지 않은 변경이 있는 탭에서 `nav`를 하면 beforeunload 다이얼로그가 뜰 수 있다. 이때 `nav`는 15초 뒤 Timeout으로 끝나고 다이얼로그 안내가 붙는다. `{"accept":false}`로 처리하면 이동이 취소되어 사용자가 입력한 내용이 남는다.
- `click`은 요소 중심을 hit-test해서 그 요소에 실제로 닿을 때만 실제 마우스 입력을 보내고, 가려졌거나 크기가 0이거나 안쪽 링크·버튼에 닿거나 select·file 입력이면 예전처럼 `el.click()`을 쓴다. 출력 끝의 괄호에 어느 쪽을 썼는지 나온다. 마우스 입력을 보낸 뒤에는 요소가 실제로 받았는지 확인해, 못 받았으면 에러로 알린다(입력은 이미 나간 상태이니 상태를 확인한 뒤 재시도한다). `disabled` 요소는 에러를 돌려준다. 마우스 입력이 문제를 일으키면 `eval "document.querySelector('<selector>').click()"`으로 예전 방식을 직접 쓴다.
- 실제 마우스 입력이라 `target=_blank` 링크가 진짜 새 탭을 연다. 클릭 전후 `list`를 비교해 새 탭을 찾고, 에이전트가 연 탭만 `evalraw <target> Page.close`로 닫는다.
- `eval`의 동기 코드는 12초 뒤 강제로 멈추고 `executionStopped`를 알린다. 15초 안에 끝나지 않으면 `mayHaveLateEffects`를 알린다. Promise를 기다리던 스크립트는 계속 돌며 나중에 페이지를 바꿀 수 있으니, 부작용이 있는 작업을 재시도하기 전에 페이지 상태를 확인한다.
- `open`으로 연 탭은 포그라운드로 열린다. 페이지 선택 기준은 위 "작업할 페이지 정하기"를 따른다.
- DOM이 바뀔 수 있으면 호출 사이에 `querySelectorAll(...)[i]` 같은 인덱스 선택을 피한다. 한 번의 `eval`로 모아서 수집하거나 안정적인 셀렉터를 쓴다.
- `shot`은 네이티브 해상도 픽셀로 찍히고 CDP 입력 좌표는 CSS 픽셀이다. 이미지 좌표를 DPR로 나눠서 쓴다.
- cross-origin iframe에 텍스트를 입력할 때는 `eval` 대신 `type`을 쓴다.

## 출력 위생 (두 모드 공통)

- 실제 프로필에 연결하면 로그인 상태, 탭, 확장, 쿠키를 그대로 물려받는다. 모든 출력을 민감정보로 취급한다.
- 쿠키, Authorization 헤더, 세션 토큰, localStorage 값, 작업과 무관한 탭 내용을 출력하지 않는다.
- `--redactNetworkHeaders`는 일부 헤더만 가린다. 응답 바디와 페이지 내용은 여전히 민감할 수 있으니 작업에 필요한 최소한만 수집한다.
- 무관한 탭, 스토리지, 요청 바디를 열어 보지 않는다. 증거가 충분해지면 멈춘다.
- 디버거 입력이나 타이밍 조작을 자동화 탐지 회피 수단으로 쓰지 않는다.

## 쿠키·캐시·스토리지 삭제 (두 모드 공통)

실제 프로필의 쿠키와 캐시는 사용자의 모든 탭이 같이 쓴다. 삭제 명령은 비슷해 보여도 영향 범위가 다르다. 어느 페이지 세션으로 보냈는지는 범위를 줄여 주지 않는다.

| 명령 | 범위 | 복구 |
| --- | --- | --- |
| `Network.deleteCookies` (name, domain, path 지정) | 쿠키 하나 | 그 사이트 재로그인 |
| `Storage.clearDataForOrigin` (`origin`, `storageTypes`) | origin 하나 | 그 사이트 재로그인 |
| `navigate_page --type reload --ignoreCache` | 페이지 로드 한 번 | 잃는 것 없음 |
| `Network.clearBrowserCookies`, `Network.clearBrowserCache`, `browserContextId` 없는 `Storage.clearCookies` | **프로필 전체** | **불가능** (모든 사이트 로그아웃) |

- 오래된 리소스 문제는 캐시를 지우지 말고 `--ignoreCache` reload로 해결한다. raw 모드에서는 `evalraw <target> Page.reload '{"ignoreCache":true}'`를 쓴다.
- 한 사이트 문제는 그 origin만 지운다. 예: `evalraw <target> Storage.clearDataForOrigin '{"origin":"https://example.com","storageTypes":"cookies"}'`
- 프로필 전체 삭제는 사용자 승인 없이 실행하지 않는다. 묻기 전에 범위를 좁힌 명령으로는 안 되는지 확인하고, 모든 사이트에서 로그아웃되며 되돌릴 수 없다는 점을 알린다.
- httpOnly 쿠키를 지워야 한다는 이유로 범위를 넓히지 않는다. `Network.deleteCookies`는 httpOnly 쿠키도 지운다.

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
