# @ryan_nookpi/pi-skill-hairline

![hairline: Adds hairline's pointer-reactive isometric line figures to web pages.](./cover.svg)

[`@lucasmarkes/hairline`](https://github.com/lucasmarkes/hairline)의 등각(isometric) 선 도형 33종을 웹 산출물에 넣는 스킬입니다. 도형은 SVG 선화이고 포인터를 따라 움직입니다. 에이전트가 프로젝트 형태를 보고 npm 설치, 단일 HTML 인라인, 정적 파일 복사 중 하나로 붙이고, 브라우저에서 동작을 확인합니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-skill-hairline
```

같은 이름의 스킬이 `~/.pi/agent/skills/hairline` 등 다른 위치에 있으면 Pi는 먼저 찾은 쪽 하나만 씁니다. 기존 로컬 복사본은 지우고 설치하세요.

## 따로 준비해야 하는 것

- Node 18 이상 (`scripts/hairline.mjs` 실행용, 외부 패키지 없음)
- 결과를 띄울 최신 브라우저

자세한 내용은 [skills/hairline/references/setup.md](skills/hairline/references/setup.md)에 있습니다.

## 사용 예

```text
랜딩 페이지 히어로에 hairline terrain 도형 넣어줘
기능 소개 카드 세 개에 어울리는 hairline 도형 골라서 붙여줘
검색 결과 없음 화면에 움직이는 빈 상태 일러스트 넣어줘
hairline 도형 갤러리를 HTML 파일 하나로 만들어줘
```

직접 부르려면 `/skill:hairline <요청>`을 쓰세요. 갤러리 페이지는 스크립트로도 만들 수 있습니다.

```bash
node skills/hairline/scripts/hairline.mjs page --figures terrain,riffle,vault --play --out demo.html
```

## 하지 않는 것

- 새 도형을 그리지 않습니다. 원본 저장소의 `hairline-create` 스킬이 그 일을 합니다.
- 원본 사이트의 이미지와 예제 HTML은 넣지 않습니다.

## 출처

도형과 런타임 코드는 모두 Lucas Marques([@lucasmarkes](https://github.com/lucasmarkes))가 만든 Hairline에서 가져왔습니다. 이 패키지는 그것을 Pi 스킬로 감싼 것이고, 원작자와는 관계가 없습니다.

- 원본 저장소: <https://github.com/lucasmarkes/hairline> (태그 `v0.5.1`, 커밋 `37d2e78`)
- npm 패키지: [`@lucasmarkes/hairline@0.5.1`](https://www.npmjs.com/package/@lucasmarkes/hairline)
- 공식 사이트와 문서: <https://hairline.lucasmarkes.com>
- 동봉 파일의 버전·tarball·integrity: [skills/hairline/assets/VERSION](skills/hairline/assets/VERSION)

`assets/hairline.js`와 `assets/hairline.d.ts`는 npm 배포본의 `dist/index.js`, `dist/index.d.ts`를 그대로 옮긴 것입니다. 위에 MIT 고지 주석을 붙이고 sourcemap 줄을 지운 것 말고는 바꾸지 않았습니다. 도형 카탈로그(`references/figures.md`)는 원본 README와 타입 설명을 한국어로 옮겨 정리한 것입니다.

## 라이선스

스킬 파일과 동봉한 `@lucasmarkes/hairline` 0.5.1 모두 MIT입니다. 원본 저작권은 Lucas Marques에게 있고, 원문은 [skills/hairline/assets/LICENSE-hairline](skills/hairline/assets/LICENSE-hairline)에 그대로 두었습니다. 동봉 라이브러리를 복사하거나 인라인한 산출물을 배포할 때는 파일 맨 위 MIT 주석을 지우지 마세요.
