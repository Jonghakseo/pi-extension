# @ryan_nookpi/pi-extension-web-access

Pi에 웹 검색과 웹 콘텐츠 추출 도구를 추가하는 익스텐션입니다. [pi-web-access](https://github.com/nicobailon/pi-web-access)(MIT)를 가져와 Exa 검색 하나만 남기고 줄인 fork입니다.

## 설치

```bash
pi install npm:@ryan_nookpi/pi-extension-web-access
```

`pi-web-access`와 도구 이름이 같습니다. 둘 중 하나만 설치하세요. 둘 다 있으면 Pi가 두 벌을 로드하고 어느 쪽 도구가 쓰일지 로드 순서로 정해집니다.

## 도구와 명령어

| 이름 | 종류 | 설명 |
|---|---|---|
| `web_search` | 도구 | Exa로 검색합니다. `queries`로 여러 검색을 한 번에 보내고, `includeContent`로 본문을 백그라운드에서 받아둘 수 있습니다 |
| `fetch_content` | 도구 | 웹 페이지, PDF, GitHub 저장소, YouTube·로컬 영상에서 텍스트를 추출합니다 |
| `get_search_content` | 도구 | 이전 `web_search`·`fetch_content` 결과의 전체 본문을 다시 가져옵니다 |
| `/search` | 명령어 | 저장된 검색 결과를 둘러보고 삭제합니다 |

모든 검색 쿼리나 모든 URL이 실패하거나, `fetch_content`에 `url`/`urls`가 없거나, `get_search_content`에 없는 `responseId`·인덱스를 넘기면 tool result에 `isError: true`가 붙습니다. 일부만 실패한 호출에는 붙지 않습니다.

## 설정

설정 없이 키 없는 Exa MCP로 동작합니다. 무료 한도를 넘기면 Exa API 키를 넣습니다.

- 환경 변수 `EXA_API_KEY`
- 또는 `~/.pi/web-search.json`

```json
{
  "exaApiKey": "...",
  "githubClone": { "enabled": true },
  "video": { "enabled": true, "maxSizeMB": 50 },
  "shortcuts": { "activity": "ctrl+shift+w" }
}
```

Exa 사용량은 `~/.pi/exa-usage.json`에 기록됩니다. PDF 추출 결과는 기본적으로 `~/Downloads`에 저장됩니다.

## 선택 의존성

없어도 설치와 검색은 됩니다. 해당 기능을 쓸 때만 필요합니다.

| 기능 | 필요한 것 | 설치 |
|---|---|---|
| GitHub 저장소 clone·API | `gh` | `brew install gh` 후 `gh auth login` |
| YouTube 영상 | `yt-dlp`, `ffmpeg` | `brew install yt-dlp ffmpeg` |
| 로컬 영상 프레임 | `ffmpeg` | `brew install ffmpeg` |

## 원본 대비 차이

- 검색 provider는 Exa(키 또는 키 없는 MCP)만 남겼습니다.
- 실패한 호출을 `isError: true`로 표시합니다(원본 0.37.0).
- Gemini·Perplexity·브라우저 쿠키 기반 경로를 제거했습니다.
- 라이선스는 원본 MIT 표기를 유지합니다. `LICENSE`를 참고하세요.
