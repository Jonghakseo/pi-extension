# hairline 준비

## 스킬 자체

따로 설치할 것은 없다. `scripts/hairline.mjs`는 Node 18 이상만 있으면 된다.

```bash
node --version   # v18 이상
node scripts/hairline.mjs list   # 33 figures가 나오면 준비 완료
```

## 대상 프로젝트

- npm 프로젝트: `npm i @lucasmarkes/hairline@^0.5.1`(pnpm/yarn/bun도 같다). 패키지는 ESM 전용이다. CommonJS 전용 빌드라면 dynamic `import()`로 부른다.
- React 래퍼(`@lucasmarkes/hairline/react`)는 React 18 이상이 필요하다.
- 단일 HTML 산출물과 `vendor` 방식은 네트워크와 패키지 설치가 필요 없다.
- `vendor`로 복사한 파일을 상대 경로로 import하는 페이지는 `file://`에서 열리지 않는다. `python3 -m http.server`나 `npx serve` 같은 정적 서버로 연다.

## 동봉 라이브러리 버전 올리기

스킬 패키지 저장소에서 아래를 실행하면 npm 배포본을 받아 `assets/`를 다시 만든다. 라이선스가 MIT가 아니거나 런타임 의존성이 생기면 중단한다.

```bash
node tools/update-vendor.mjs <version>
```
