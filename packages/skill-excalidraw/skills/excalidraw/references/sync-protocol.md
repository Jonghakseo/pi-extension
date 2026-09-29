# 앱 내부 구조 (유지보수용)

## 구성

- `scripts/excal.mjs`: CLI. 빌드 확인, 데몬 기동, 파일 등록, Chrome `--app` 창 실행, lint/inspect.
- `scripts/server.mjs`: Node 내장 모듈만 쓰는 데몬. `127.0.0.1`에만 바인딩. 기본 포트 47813(사용 중이면 임의 포트). 창 푸시는 최소 WebSocket 구현(서버→창 텍스트 프레임, 20초 ping). SSE는 Chrome의 origin당 HTTP/1.1 연결 6개를 창마다 하나씩 차지해 6번째 창부터 모든 요청이 막히므로 쓰지 않는다.
- `app/`: Vite + React + `@excalidraw/excalidraw` 0.18.1 + `@excalidraw/mermaid-to-excalidraw`. `app/src/scene.js`에 변환·병합 순수 로직, `app/src/main.jsx`에 동기화 로직.
- 상태: `~/.cache/pi-excalidraw/` (`EXCAL_STATE_DIR`로 변경). `server.json`(pid/port), `token`, `files.json`(id→경로), `history/<id>/`, `snapshots/`, `server.log`, `chrome-profile/`.

## 환경 변수

| 변수 | 용도 |
|---|---|
| `EXCAL_STATE_DIR` | 상태 디렉터리 |
| `EXCAL_PORT` | 선호 포트 |
| `EXCAL_IDLE_MINUTES` | 무접속 자동 종료(기본 30) |
| `EXCAL_BROWSER=none` | 창을 띄우지 않음 |
| `EXCAL_CHROME_ARGS` | Chrome 추가 인자 (예: `--remote-debugging-port=9333`) |

## 동기화

- 파일 id는 실제 경로의 sha1 앞 12자리. 창 URL은 `/?file=<id>&token=<token>`.
- 창은 `ws://…/api/files/<id>/ws?clientId&token`에 붙는다. 메시지는 `{event, data}` JSON이고 event는 `hello`·`scene`·`snapshot`·`problem`. 끊기면 지수 백오프(최대 5초)로 재접속하고 `hello`를 받으면 최신 scene을 GET한다.
- 서버는 파일이 아니라 디렉터리를 `fs.watch`한다(임시 파일 + rename 저장 대응). 80ms debounce 후 해시가 바뀌었고 JSON이 유효하면 `rev`를 올리고 `scene` 이벤트로 내용을 보낸다. 받아들이기 직전 내용은 `history/`에 백업한다.
- 창은 PUT `/api/files/<id>/scene`에 `{baseRev, content, clientId}`를 보낸다. `baseRev`가 현재 `rev`와 다르면 409와 최신 내용을 돌려준다. 서버는 자기가 쓴 해시를 기억해 watch 에코를 무시한다.
- 창의 원격 반영 순서:
  1. `pendingMermaid`가 있으면 mermaid 결과로 요소 전체 교체.
  2. 스켈레톤 정규화(`convertMixed`). 정식 frame에는 `children: []`를 넣어 변환기 크래시를 막는다.
  3. `repairScene`: 도형 이동에 따른 직선 화살표 재계산, 바인딩 역참조 보강.
  4. `restoreElements(remote, local, {refreshDimensions, repairBindings})`: 텍스트 재측정, 끊긴 바인딩 제거.
  5. `recenterLabels`: 재측정된 크기로 라벨을 도형 안에 다시 정렬.
  6. 저장 안 된 로컬 변경이 있으면 `threeWayMerge`.
  7. 파일에서 사라진 요소는 `isDeleted` tombstone으로, 내용이 바뀐 요소는 `version+1`·새 `versionNonce`로 만든다. Excalidraw Store는 versionNonce로 변경을 감지하므로 이게 없으면 LLM 변경이 히스토리에 안 남고, 이후 Cmd+Z가 LLM 이전 값으로 되감긴다.
  8. `updateScene({captureUpdate: IMMEDIATELY})`, 바뀐 요소는 토스트로만 알린다(선택 상태는 건드리지 않음).
  9. 1–5단계에서 내용이 바뀌었거나 병합으로 로컬 변경이 남았으면 곧바로 파일에 다시 저장한다.
- 3-way 기준선: 마지막 동기화 시점의 요소별 `{version, contentKey}`. 로컬만 바뀐 요소는 로컬, 원격이 바뀐 요소는 원격이 이긴다.
- 로컬 편집 저장: `onChange`에서 요소 version 합이 바뀐 경우만 400ms debounce 후 PUT.
- 스냅샷: CLI → POST `/snapshot` → 서버가 첫 번째 연결 창에 `snapshot {reqId, rev}` → 창이 해당 rev 반영까지 최대 5초 대기 후 `exportToBlob` → POST `/api/snapshots/<reqId>` → CLI가 PNG 저장. 창이 그 rev를 반영하지 못했으면(마지막 반영 오류 포함) PNG 대신 에러 JSON을 보내고 CLI는 실패로 끝난다.

## 보안

- `127.0.0.1` 바인딩, Host 헤더 검사(`127.0.0.1:<port>`, `localhost:<port>`만 허용, WebSocket upgrade 포함), `/api/*`는 토큰(`x-excal-token` 헤더 또는 `token` 쿼리) 필수.
- 읽기·쓰기는 `excal open`으로 등록한 파일만 가능하다.

## 폰트

빌드할 때 `node_modules/@excalidraw/excalidraw/dist/prod/fonts`를 `dist/fonts`로 복사하고 `window.EXCALIDRAW_ASSET_PATH = "/"`로 로컬에서 서빙한다(오프라인 동작, 한글은 Xiaolai 손글씨 대체 폰트). 로컬 로드에 실패하면 Excalidraw가 CDN으로 폴백한다.
