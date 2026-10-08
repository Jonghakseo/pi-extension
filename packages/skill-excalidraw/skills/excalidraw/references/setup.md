# excalidraw 최초 설정

빌드된 편집기 앱이 패키지에 들어 있어 따로 설치·빌드할 것은 없다. 창을 띄울 브라우저만 필요하다.

## 1. 브라우저 확인

```bash
open -Ra "Google Chrome" && echo ok      # macOS
```

`ok`가 나오면 다음 단계로 간다. Linux는 `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` 중 하나가 PATH에 있으면 된다.

`ok`가 안 나오면 macOS는 Google Chrome이 필요하다. Chromium이나 다른 브라우저로는 창이 열리지 않는다.

```bash
brew install --cask google-chrome
```

또는 https://www.google.com/chrome/ 에서 내려받는다.

## 2. 동작 확인

동봉된 예제로 창 띄우기와 PNG 내보내기까지 한 번에 확인한다. 아래 `SKILL_DIR`은 이 문서가 들어 있는 스킬 디렉터리의 절대 경로다.

```bash
SKILL_DIR=<이 스킬 디렉터리>
cp "$SKILL_DIR/assets/examples/flowchart.excalidraw" /tmp/excal-check.excalidraw
node "$SKILL_DIR/scripts/excal.mjs" open /tmp/excal-check.excalidraw
node "$SKILL_DIR/scripts/excal.mjs" snapshot /tmp/excal-check.excalidraw -o /tmp/excal-check.png
```

- `open` 출력의 `"window"`가 `"opened"`이고 주문 처리 흐름도가 뜬 Chrome 창이 보이면 정상이다.
- `snapshot`이 `/tmp/excal-check.png`를 출력하면 내보내기까지 된 것이다. 이미지를 열어 한글 라벨이 깨지지 않았는지 본다.
- `"window"`가 `"no-browser"`면 1번 단계로 돌아간다. `"not-connected"`면 Chrome은 있는데 창이 안 뜬 것이니 열린 Chrome 창과 다른 데스크톱(Space)을 확인한다.

확인이 끝나면 정리한다.

```bash
node "$SKILL_DIR/scripts/excal.mjs" stop
rm -f /tmp/excal-check.excalidraw /tmp/excal-check.png
```

## 앱을 직접 빌드할 때

`build`는 `app/` 소스를 고쳤을 때만 쓴다. 이 레포 안에서 쓰는 경우 `app/`은 pnpm 워크스페이스 글롭(`packages/*`)에 걸리지 않는 비멤버라서, 설치할 때 `--ignore-workspace`가 없으면 상위 워크스페이스가 대신 설치되고 `app/node_modules`가 비어 빌드가 깨진다. `excal build`는 이 플래그를 알아서 붙인다. 손으로 돌릴 때는 이렇게 한다.

```bash
pnpm --dir "$SKILL_DIR/app" install --ignore-workspace --frozen-lockfile
pnpm --dir "$SKILL_DIR/app" run build
```

빌드에는 Node `^20.19 || >=22.12`가 필요하다(vite 8). 스킬을 쓰기만 할 때는 Node 18 이상이면 된다.

## 참고

- 창은 사용자 Chrome 프로필과 분리된 전용 프로필(`~/.cache/pi-excalidraw/chrome-profile`)로 열린다. 로그인 정보나 확장 프로그램은 공유되지 않는다.
- 상태 디렉터리는 `EXCAL_STATE_DIR`로 바꿀 수 있다.
- 브라우저 없이 쓰려면 `EXCAL_BROWSER=none`을 주고, 출력된 URL을 직접 연다. `lint`, `inspect`는 브라우저가 필요 없다.
