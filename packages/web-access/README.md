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
| `fetch_content` | 도구 | 웹 페이지(서버가 마크다운을 주면 그대로 사용), PDF, GitHub 저장소·PR·이슈, YouTube·로컬 영상에서 텍스트를 추출합니다. `mode: "raw"`를 주면 HTTP(S) 응답 본문을 가공 없이 돌려줍니다 |
| `get_search_content` | 도구 | 이전 `web_search`·`fetch_content` 결과의 전체 본문을 다시 가져옵니다 |
| `/search` | 명령어 | 저장된 검색 결과를 둘러보고 삭제합니다 |

모든 검색 쿼리나 모든 URL이 실패하거나, `fetch_content`에 `url`/`urls`가 없거나, `get_search_content`에 없는 `responseId`·인덱스를 넘기면 tool result에 `isError: true`가 붙습니다. 일부만 실패한 호출에는 붙지 않습니다.

`fetch_content`의 `mode`는 `readable`(기본)과 `raw`입니다. `raw`는 JSON, XML, 일반 텍스트 같은 텍스트 응답의 본문을 그대로 반환합니다. 마크다운 우선 Accept 헤더를 쓰지 않고, Readability 변환도 하지 않습니다. 응답은 5MB까지, 타임아웃은 기본 30초입니다. 이미지·PDF 같은 비텍스트 content-type은 에러로 돌려주고, HTTP 오류 상태는 본문과 함께 에러로 표시합니다. GitHub·YouTube·로컬 영상 처리와 Jina 폴백은 타지 않으며 `http://`, `https://` 외의 URL은 거부합니다.

```
fetch_content({ url: "https://example.com/api/items.json", mode: "raw" })
```

`github.com/<owner>/<repo>/pull/<n>`과 `/issues/<n>` URL(`#issuecomment-...`, `#discussion_r...` 앵커 포함)은 `gh api`로 가져와 제목, 상태, 본문, 대화 코멘트를 마크다운으로 렌더합니다. PR이면 브랜치, 변경 파일, 리뷰 결과, 리뷰 코멘트도 들어갑니다. 코멘트·파일은 목록마다 최대 300개(100개씩 3페이지)까지 읽고, 더 있으면 그렇다고 표시합니다. 앵커가 가리키는 코멘트가 목록에 없으면 따로 가져와 `[anchored]`로 표시하며, 그 코멘트가 URL의 PR·이슈에 속하지 않으면 쓰지 않습니다. `gh`가 없거나 로그인되지 않았거나 호출이 실패하면 일반 HTTP 추출로 넘어갑니다. 저장소 루트나 `blob`·`tree` URL은 기존 GitHub 저장소 처리를 그대로 탑니다.

추출한 텍스트 안의 `data:` URI(base64 이미지 등)는 `[pi-web-access inline data URI omitted; mime=...; encodedBytes=...; sha256=...]` 형태의 표시로 바뀝니다. 모델 출력과 세션에 저장되는 본문 어디에도 base64 페이로드가 남지 않습니다. `web_search`가 함께 가져온 본문도 저장 전에 같은 처리를 거칩니다. `mode: "raw"`는 본문을 그대로 돌려주는 모드라서 이 처리를 하지 않습니다.

## 설정

설정 없이 키 없는 Exa MCP로 동작합니다. 무료 한도를 넘기면 Exa API 키를 넣습니다.

- 환경 변수 `EXA_API_KEY`
- 또는 `~/.pi/web-search.json`

```json
{
  "exaApiKey": "...",
  "githubClone": { "enabled": true },
  "githubPrIssue": { "enabled": true },
  "video": { "enabled": true, "maxSizeMB": 50 },
  "fetchContent": {
    "domainPolicy": { "allow": ["example.com"], "deny": ["blocked.example.com"] }
  },
  "ssrf": { "allowRanges": ["198.18.0.0/15"] },
  "shortcuts": { "activity": "ctrl+shift+w" }
}
```

`fetch_content`가 직접 보내는 HTTP(S) 요청(일반 추출, `mode: "raw"`, PDF 다운로드)은 SSRF 가드를 거칩니다. 호스트를 DNS로 풀어 사설·루프백·링크로컬·메타데이터 주소(`10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `fc00::/7` 등)로 향하면 요청 전에 막고, redirect는 수동으로 따라가며 매 hop을 다시 검사합니다. Surge 같은 TUN/fake-IP 프록시가 공개 도메인을 `198.18.0.0/15`로 풀어 막히는 환경이라면 `ssrf.allowRanges`에 필요한 CIDR만 적어 예외로 둘 수 있습니다. 잘못된 항목은 조용히 무시하지 않고 에러가 납니다.

`fetchContent.domainPolicy`는 선택 사항이고 생략하면 꺼집니다. 호스트 이름은 자기 자신과 서브도메인에 모두 매치되며, 두 목록에 다 걸리면 `deny`가 이깁니다. `allow`가 비어 있지 않으면 거기에 없는 호스트는 거부합니다. GitHub·YouTube처럼 별도 처리하는 URL과 redirect 대상에도 적용하고, 로컬 파일 경로는 대상이 아닙니다. 막힌 URL은 Jina Reader 폴백으로도 보내지 않습니다. 설정이 잘못되면 fetch를 허용하지 않고 에러를 돌려줍니다.

Exa 사용량은 `~/.pi/exa-usage.json`에 기록됩니다. PDF 추출 결과는 기본적으로 `~/Downloads`에 저장됩니다.

## 선택 의존성

없어도 설치와 검색은 됩니다. 해당 기능을 쓸 때만 필요합니다.

| 기능 | 필요한 것 | 설치 |
|---|---|---|
| GitHub 저장소 clone·API, PR·이슈 추출 | `gh` | `brew install gh` 후 `gh auth login` |
| YouTube 영상 | `yt-dlp`, `ffmpeg` | `brew install yt-dlp ffmpeg` |
| 로컬 영상 프레임 | `ffmpeg` | `brew install ffmpeg` |

## 원본 대비 차이

- 검색 provider는 Exa(키 또는 키 없는 MCP)만 남겼습니다.
- 실패한 호출을 `isError: true`로 표시합니다(원본 0.37.0).
- `fetch_content`가 HTTP 요청에서 `text/markdown`을 먼저 요청합니다(원본 0.36.0). 서버가 `text/markdown`·`text/x-markdown`으로 답하면 Readability를 거치지 않고 본문을 그대로 씁니다. 500자 미만의 짧은 마크다운은 브라우저 Accept 헤더로 한 번 더 요청합니다.
- `fetch_content`에 `mode: "raw"`를 추가했습니다(원본). 원본의 `answer` 모드와 `auth` 프로필은 가져오지 않았습니다.
- 추출 텍스트의 인라인 `data:` URI를 길이가 들어간 생략 표시로 바꿉니다(원본의 `data-uri-sanitize`). 원본과 같이 `raw` 모드는 제외합니다.
- 직접 fetch에 SSRF 가드와 `fetchContent.domainPolicy`를 넣었습니다(원본의 `ssrf-protection`). 이 fork에는 프록시 경로가 없어 `ssrf.trustEnvProxy`와 프록시 관련 처리는 가져오지 않았고, `ssrf.allowRanges`만 남겼습니다.
- GitHub PR·이슈 URL을 `gh api`로 가져와 렌더합니다(원본의 `github-issue-pr`). 원본의 `gh pr view --json` 필드 조합, REST 폴백, 체크 롤업·연결된 이슈 표시는 가져오지 않았습니다. `gh`가 실패하면 일반 HTTP 추출로 넘어갑니다. 끄려면 `githubPrIssue.enabled: false`입니다.
- Gemini·Perplexity·브라우저 쿠키 기반 경로를 제거했습니다.
- 라이선스는 원본 MIT 표기를 유지합니다. `LICENSE`를 참고하세요.
