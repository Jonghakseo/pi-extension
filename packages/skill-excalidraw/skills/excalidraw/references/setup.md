# excalidraw 최초 설정

빌드된 편집기 앱이 패키지에 들어 있어 따로 설치·빌드할 것은 없다. 창을 띄울 브라우저만 필요하다.

## 확인

```bash
open -Ra "Google Chrome" && echo ok      # macOS
```

`ok`가 나오면 설정할 것이 없다. Linux는 `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` 중 하나가 PATH에 있으면 된다.

## 설치 (1회)

macOS는 Google Chrome이 필요하다. Chromium이나 다른 브라우저로는 창이 열리지 않는다.

```bash
brew install --cask google-chrome
```

또는 https://www.google.com/chrome/ 에서 내려받는다.

## 참고

- 창은 사용자 Chrome 프로필과 분리된 전용 프로필(`~/.cache/pi-excalidraw/chrome-profile`)로 열린다. 로그인 정보나 확장 프로그램은 공유되지 않는다.
- 상태 디렉터리는 `EXCAL_STATE_DIR`로 바꿀 수 있다.
- 브라우저 없이 쓰려면 `EXCAL_BROWSER=none`을 주고, 출력된 URL을 직접 연다. `lint`, `inspect`는 브라우저가 필요 없다.
