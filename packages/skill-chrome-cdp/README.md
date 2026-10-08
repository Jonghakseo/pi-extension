# @ryan_nookpi/pi-skill-chrome-cdp

사용자가 로그인해 둔 실제 Chrome 세션과 열린 탭을 검사하고 조작하는 스킬입니다. 공식 `chrome-devtools` CLI의 auto-connect를 주로 쓰고, 임의 CDP 메서드가 필요하면 `scripts/cdp.mjs`로 직접 호출합니다. 사용자가 요청했을 때만 연결하며, Chrome의 Allow 대화상자는 사용자가 직접 눌러야 합니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-chrome-cdp
```

같은 이름의 스킬이 `~/.pi/agent/skills/chrome-cdp` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 준비해야 하는 것

- Chrome 144 이상
- `chrome://inspect/#remote-debugging`에서 원격 디버깅 토글 켜기
- `chrome-devtools` CLI (`npm install -g chrome-devtools-mcp@latest`, Node 20.19 이상)

자세한 순서와 연결 확인 방법은 [skills/chrome-cdp/references/setup.md](skills/chrome-cdp/references/setup.md)에 있습니다. 준비가 덜 된 상태에서 스킬을 부르면 에이전트가 빠진 단계만 짧게 알려 줍니다. macOS 기준으로 검증했습니다.

## 사용 예

```text
지금 열린 탭에서 콘솔 에러 확인해줘
어드민 페이지에서 주문 목록 API 응답이 어떻게 오는지 봐줘
지금 보고 있는 화면 스크린샷 찍어줘
이 폼에 테스트 값 채워서 제출 버튼 눌렀을 때 에러 재현해줘
```

요청 내용이 스킬 설명과 맞으면 에이전트가 알아서 스킬을 불러옵니다. 직접 부르려면 `/skill:chrome-cdp <요청>`을 쓰세요.

처음 연결할 때 Chrome에 Allow 창이 뜹니다. 눌러야 진행되고, 작업이 끝나면 에이전트가 연결을 끊습니다. 다음 작업에서는 다시 눌러야 합니다.

## 하지 않는 것

- Allow 창을 대신 누르거나 우회하지 않습니다.
- 쿠키, 토큰, Authorization 헤더, localStorage 값을 출력하지 않습니다.
- 요청과 무관한 탭은 열어 보지 않습니다.
