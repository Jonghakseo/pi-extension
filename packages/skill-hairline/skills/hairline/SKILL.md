---
name: hairline
description: "웹 페이지·HTML 산출물·React 화면에 포인터에 반응하는 등각(isometric) 선 도형 일러스트를 넣을 때 사용한다."
license: MIT (skill files and vendored @lucasmarkes/hairline; see assets/LICENSE-hairline)
compatibility: 도형 실행에는 DOM이 있는 최신 브라우저가 필요하다. scripts/hairline.mjs는 Node 18 이상에서 동작하고 외부 패키지를 쓰지 않는다. 동봉 라이브러리는 @lucasmarkes/hairline 0.5.1이다.
---

# hairline

[`@lucasmarkes/hairline`](https://github.com/lucasmarkes/hairline)의 도형 33종을 웹 산출물에 붙인다. 도형은 SVG 선화로 그려지고 포인터 위치에 따라 움직이며, 요소 너비에 맞춰 5:4 비율로 자리를 잡는다. 런타임 의존성은 없다. React 래퍼만 React 18 이상을 peer로 쓴다.

새 도형을 그리는 스킬이 아니다. 동봉된 33종 안에서 고른다. 직접 만든 도형이 필요하면 원본 저장소의 `hairline-create` 스킬을 안내한다.

## Workflow

### 1. 도형 고르기

`references/figures.md`에서 화면 의미에 맞는 도형을 고른다. 최신 목록과 원문 설명은 아래 명령으로 본다.

```bash
node scripts/hairline.mjs list
```

한 화면에 도형을 많이 깔지 않는다. 히어로 하나, 또는 기능 카드마다 하나 정도가 원본이 의도한 밀도다.

### 2. 통합 방식 정하기

| 상황 | 방법 |
| --- | --- |
| package.json이 있는 프로젝트(React, Next.js, Vite, Svelte 등) | `npm i @lucasmarkes/hairline@^0.5.1` 후 import. 기본값이다 |
| 파일 하나로 열리는 HTML 산출물, 오프라인 데모, 갤러리 | `node scripts/hairline.mjs page ...` 또는 라이브러리 인라인 |
| 번들러 없는 정적 사이트 폴더 | `node scripts/hairline.mjs vendor <dir>` 후 상대 경로 import |
| 네트워크가 되는 빠른 프로토타입 | `https://esm.sh/@lucasmarkes/hairline@0.5.1`에서 import (버전 고정) |

#### npm 프로젝트

React(클라이언트 모듈이라 Server Component에서도 그대로 렌더 가능):

```tsx
import { Terrain } from "@lucasmarkes/hairline/react";

export function Hero() {
  return <Terrain intensity={0.7} style={{ maxWidth: 480 }} />;
}
```

그 밖의 DOM 환경:

```ts
import { terrain } from "@lucasmarkes/hairline";

const figure = terrain(document.getElementById("figure")!, { play: true });
figure.update({ intensity: 0.8 });
figure.destroy(); // 언마운트 시 반드시 호출
```

컴포넌트 이름은 함수 이름의 첫 글자를 대문자로 바꾼 것이다(`riffle` → `Riffle`). 함수 시그니처는 Svelte action과 같아서 `use:terrain={{ intensity }}`로도 쓴다.

#### 단일 HTML 파일

갤러리나 데모 페이지가 필요하면 생성기를 쓴다. 라이브러리와 MIT 고지가 페이지 안에 인라인되어 `file://`로 바로 열린다.

```bash
node scripts/hairline.mjs page --figures terrain,riffle,slow --title "기능 소개" \
  --lang ko --theme auto --intensity 0.5 --play --out hairline-demo.html
```

옵션: `--columns N`(기본 min(도형 수, 3)), `--theme auto|light|dark`, `--play`(포인터가 없을 때 스스로 시연).

직접 설계한 페이지에 넣을 때는 `assets/hairline.js` 전체를 `<script type="module">` 안에 붙이고, 파일 끝의 `export { ... };` 블록만 지운 뒤 같은 스크립트에서 함수를 호출한다. 파일 맨 위의 `/*! ... MIT License ... */` 주석은 지우지 않는다. 문자열 `</script`가 생기면 `<\/script`로 바꾼다(현재 버전에는 없다).

#### 정적 사이트 폴더

```bash
node scripts/hairline.mjs vendor site/vendor/hairline
```

`hairline.js`, `hairline.d.ts`, `LICENSE-hairline`이 복사된다. `import { vault } from "./vendor/hairline/hairline.js"`로 쓴다. 브라우저는 `file://`에서 다른 파일의 ES 모듈 import를 막으므로 이 방식은 HTTP 서버로 확인한다.

### 3. 옵션과 테마 맞추기

모든 도형은 같은 옵션 다섯 개를 받는다. 전부 선택이다.

| 옵션 | 기본값 | 뜻 |
| --- | --- | --- |
| `intensity` | `0.5` | 포인터에 반응하는 세기. 0~1 밖은 잘린다 |
| `theme` | `"auto"` | `"auto"`는 조상의 `.dark`/`data-theme="dark"`, 그다음 `color-scheme`을 따른다 |
| `label` | 영어 설명 | 접근성 이름. 한국어 페이지면 한국어로 넣는다. React에서는 `aria-label`도 된다 |
| `onRead` | 없음 | 캡션(`"03"`, `"gap 28.0"`, `"rate 0.20×"`)이 바뀔 때마다 호출 |
| `play` | `false` | 포인터나 포커스가 없을 때 스스로 반응을 반복 시연 |

`update`에서 키를 `undefined`로 주면 기본값으로 돌아가고, 빠진 키는 그대로 유지된다.

색은 CSS 변수로 바꾼다. 도형이나 그 조상에 지정한다.

```css
.figures {
  --hairline-plate: #101014; /* 판 채움색. 페이지 배경과 같게 */
  --hairline-hi: #fafafa;    /* 강조 선 */
  --hairline-edge: #a1a1aa;  /* 외곽선 */
  --hairline-mid: #52525b;   /* 나머지 선 */
  --hairline-lo: #27272a;    /* 뒤로 물러나는 선 */
  --hairline-stroke: 0.9;    /* 선 굵기(CSS px) */
}
```

배경이 흰색이나 `#08090a`가 아니면 `--hairline-plate`를 반드시 그 배경색으로 맞춘다. 판은 뒤의 선을 가리려고 칠해져 있어서, 안 맞추면 네모난 얼룩이 보인다. 도형 스타일은 specificity가 0이라 `!important` 없이 덮어쓸 수 있다.

### 4. 확인

1. 페이지를 브라우저로 연다. 각 컨테이너 안에 `[data-hairline] > svg`가 생겼는지, 콘솔 에러가 없는지 본다.
2. 포인터를 도형 위로 움직여 모양과 `onRead` 캡션이 바뀌는지 본다.
3. 다크 테마를 쓰면 다크에서도 한 번 본다. 판 색이 배경과 어긋나 보이면 `--hairline-plate`를 고친다.

브라우저 자동화가 가능하면(Playwright, `chrome-cdp` 스킬 등) 위 세 가지를 스크린샷과 DOM 조회로 확인한다. 확인하지 못했으면 못 했다고 보고한다.

## 라이선스 고지

`@lucasmarkes/hairline`은 MIT다(Copyright (c) 2026 Lucas Marques). 상업적 사용·수정·재배포가 가능하고, 코드의 상당 부분을 복사해 배포하는 산출물에는 저작권 표시와 허가 문구를 함께 넣어야 한다.

- npm으로 설치하면 고지는 `node_modules/@lucasmarkes/hairline/LICENSE`로 따라간다. 따로 할 일은 없다. 번들된 앱을 배포하면 평소 쓰는 서드파티 고지 목록에 포함시킨다.
- `assets/hairline.js`를 인라인하거나 복사하면 파일 맨 위 MIT 주석을 그대로 남긴다. 주석을 지우는 minify 단계가 있으면 `/*!` 주석 보존 옵션을 켜거나 `LICENSE-hairline`을 함께 배포한다.
- 원본 사이트의 이미지(`hero.gif`, `og.png`, inspo 이미지)나 사이트 예제 HTML은 이 스킬에 들어 있지 않다. 쓰지 않는다.

## Edge cases

- 컨테이너 너비가 0이면 도형도 0 크기로 그려진다. 너비가 정해진 블록 요소에 마운트한다(`display:block` 또는 grid/flex 자식으로 폭 지정).
- 함수는 DOM이 필요하다. SSR 환경에서는 effect, `onMount`, 또는 요소 뒤의 스크립트에서 호출한다. React 컴포넌트는 서버에서 5:4 빈 박스로 렌더되어 레이아웃이 밀리지 않는다.
- `prefers-reduced-motion`이면 스스로 움직이는 도형(`phosphor`, `slow`)과 `play`는 멈추고, 포인터 반응만 남는다.
- `riffle`만 포커스 가능한 그룹이다. 화살표 키로 카드를 넘기고 라이브 영역이 읽어 준다. 나머지는 설명이 붙은 이미지다.
- 도형 여러 개는 `requestAnimationFrame` 루프 하나를 공유하고, 화면 밖이거나 쉬는 도형은 일하지 않는다.
- Shadow DOM 안에 마운트해도 그 shadow root에 스타일을 넣는다.
- SPA에서 화면을 바꿀 때 `destroy()`를 빼먹으면 이벤트와 루프가 남는다.
