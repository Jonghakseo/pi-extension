# @ryan_nookpi/pi-skill-chrome-cdp

사용자가 로그인해 둔 실제 Chrome 세션과 열린 탭을 검사하고 조작하는 스킬입니다. 공식 `chrome-devtools` CLI의 auto-connect를 주로 쓰고, 임의 CDP 메서드가 필요하면 `scripts/cdp.mjs`로 직접 호출합니다. 사용자가 요청했을 때만 연결하며, Chrome의 Allow 대화상자는 사용자가 직접 눌러야 합니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-chrome-cdp
```

같은 이름의 스킬이 `~/.pi/agent/skills/chrome-cdp` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 설치해야 하는 것

Chrome 144 이상, 원격 디버깅 허용, `chrome-devtools` CLI(`chrome-devtools-mcp`)

처음 한 번 설치하는 방법은 [skills/chrome-cdp/references/setup.md](skills/chrome-cdp/references/setup.md)에 있습니다. 스킬도 전제가 빠졌을 때 이 문서를 보고 안내합니다.

## 사용 예

```text
/skill:chrome-cdp 지금 열린 탭에서 콘솔 에러 확인해줘
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 불러오므로, 명시적으로 `/skill:chrome-cdp`을 쓰지 않아도 됩니다.
