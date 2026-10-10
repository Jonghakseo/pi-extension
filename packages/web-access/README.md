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
| `web_search` | 도구 | Exa 또는 Codex 구독 OpenAI로 검색합니다(`provider`). `queries`로 여러 검색을 한 번에 보내고, `includeContent`로 본문을 백그라운드에서 받아둘 수 있습니다. `category`(`news`, `research paper`, `pdf`, `github` 등)로 Exa 결과 종류를 좁힐 수 있습니다 |
| `fetch_content` | 도구 | 웹 페이지(서버가 마크다운을 주면 그대로 사용), PDF, GitHub 저장소·PR·이슈, YouTube·로컬 영상에서 텍스트를 추출합니다. `mode: "raw"`를 주면 HTTP(S) 응답 본문을 가공 없이 돌려줍니다 |
| `get_search_content` | 도구 | 이전 `web_search`·`fetch_content` 결과의 본문을 다시 가져옵니다. `offset`/`limit`로 잘라 읽거나 `findText`로 일치 구절만 찾을 수 있습니다 |
| `/search` | 명령어 | 저장된 검색 결과를 둘러보고 삭제합니다 |

모든 검색 쿼리나 모든 URL이 실패하거나, `fetch_content`에 `url`/`urls`가 없거나, `get_search_content`에 없는 `responseId`·인덱스를 넘기면 tool result에 `isError: true`가 붙습니다. 일부만 실패한 호출에는 붙지 않습니다.

`web_search`의 `provider`는 `auto`(기본), `exa`, `openai`입니다.

- `auto`: 현재 모델이 Codex 구독 모델(`openai-codex`)이면 OpenAI 호스티드 검색을 먼저 쓰고, 실패하면 Exa로 넘어갑니다. 다른 모델이면 Exa만 씁니다. 이 경로의 OpenAI 시도는 20초 타임아웃이고, Exa로 넘어가면 답변 맨 앞에 실패 사유를 짧은 노트로 붙입니다. 사용자가 중단하면 폴백하지 않습니다.
- `exa`: 항상 Exa입니다.
- `openai`: OpenAI만 씁니다. Codex 로그인이 없으면 폴백 없이 `/login` 안내 에러를 돌려줍니다.

OpenAI 검색은 Pi `/login`으로 로그인한 Codex(ChatGPT 구독) 자격이 있어야 하고, 호출할 때마다 구독 사용량을 씁니다. 그 OAuth 토큰만 `https://chatgpt.com/backend-api/codex/responses`로 보내며 에러 메시지에서는 가립니다. 요청 타임아웃은 60초입니다. 검색에 쓰는 모델은 가장 최신 `luna` 계열(없으면 최신 `gpt-N`)을 고르고, `openaiSearchModel`로 고정할 수 있습니다. 도메인 필터는 호스티드 검색의 `allowed_domains`/`blocked_domains`로, 최근성과 `category`는 지시문으로 전달합니다. 결과는 인용 출처 목록과 요약 답변입니다.

`fetch_content`의 `mode`는 `readable`(기본)과 `raw`입니다. `raw`는 JSON, XML, 일반 텍스트 같은 텍스트 응답의 본문을 그대로 반환합니다. 마크다운 우선 Accept 헤더를 쓰지 않고, Readability 변환도 하지 않습니다. 응답은 5MB까지, 타임아웃은 기본 30초입니다. 이미지·PDF 같은 비텍스트 content-type은 에러로 돌려주고, HTTP 오류 상태는 본문과 함께 에러로 표시합니다. GitHub·YouTube·로컬 영상 처리와 Jina 폴백은 타지 않으며 `http://`, `https://` 외의 URL은 거부합니다.

```
fetch_content({ url: "https://example.com/api/items.json", mode: "raw" })
```

`github.com/<owner>/<repo>/pull/<n>`과 `/issues/<n>` URL(`#issuecomment-...`, `#discussion_r...` 앵커 포함)은 `gh api`로 가져와 제목, 상태, 본문, 대화 코멘트를 마크다운으로 렌더합니다. PR이면 브랜치, 변경 파일, 리뷰 결과, 리뷰 코멘트도 들어갑니다. 코멘트·파일은 목록마다 최대 300개(100개씩 3페이지)까지 읽고, 더 있으면 그렇다고 표시합니다. 앵커가 가리키는 코멘트가 목록에 없으면 따로 가져와 `[anchored]`로 표시하며, 그 코멘트가 URL의 PR·이슈에 속하지 않으면 쓰지 않습니다. `gh`가 없거나 로그인되지 않았거나 호출이 실패하면 일반 HTTP 추출로 넘어갑니다. 저장소 루트나 `blob`·`tree` URL은 기존 GitHub 저장소 처리를 그대로 탑니다.

추출한 텍스트 안의 `data:` URI(base64 이미지 등)는 `[pi-web-access inline data URI omitted; mime=...; encodedBytes=...; sha256=...]` 형태의 표시로 바뀝니다. 모델 출력과 세션에 저장되는 본문 어디에도 base64 페이로드가 남지 않습니다. `web_search`가 함께 가져온 본문도 저장 전에 같은 처리를 거칩니다. `mode: "raw"`는 본문을 그대로 돌려주는 모드라서 이 처리를 하지 않습니다.

`fetch_content`가 가져온 URL 전문은 세션 JSONL이 아니라 Pi 설정 디렉터리(`~/.pi`) 아래 `web-search-cache`에 저장됩니다. 세션에는 URL·제목·길이 같은 메타데이터와 캐시 참조만 남습니다. 캐시 수명은 1시간이고 최대 128개, 128MiB입니다. 한도를 넘으면 오래된 항목부터 지웁니다. macOS·Linux에서 디렉터리는 `0700`, 파일은 `0600`으로 유지합니다. `PI_WEB_ACCESS_CACHE_ROOT`로 루트 디렉터리를 바꿀 수 있고, 캐시는 그 안의 `web-search-cache`에 생깁니다. 같은 값 없이 이어 연 세션은 거기 저장된 본문을 읽지 못합니다. 캐시가 만료되거나 지워진 뒤 `get_search_content`를 부르면 "Cached fetched content is missing or expired" 에러가 URL별로 나옵니다. 캐시 도입 전 세션에 본문이 그대로 들어 있는 기록은 1시간 안이면 그대로 읽힙니다.

Pi `codemode` 스크립트에서 `tools.web_search`와 `tools.fetch_content`를 부르면 텍스트 대신 구조화된 데이터를 돌려줍니다(두 도구의 `outputSchema`). `web_search`는 `{ responseId, fetchId, queries: [{ query, answer, error, provider?, results: [{ title, url, snippet }] }] }`이고, `fetch_content`는 `{ responseId, urls: [{ url, title, content, error, duration? }] }`입니다. `content`는 모델에게 보이는 30,000자 상한 없이 추출한 전문입니다. 모든 쿼리나 URL이 실패해도 쿼리·URL별 `error`가 담긴 데이터가 함께 오고 `isError`가 붙습니다. 스크립트가 부른 `web_search`에서는 `includeContent`가 백그라운드 대신 본문을 받을 때까지 기다리고, 결과의 `fetchId`로 `get_search_content`를 쓸 수 있습니다. 모델이 직접 부를 때의 출력은 그대로입니다.

```js
const { queries } = await tools.web_search({ queries: ["pi codemode", "exa search"] });
const pages = await tools.fetch_content({ urls: queries.flatMap((q) => q.results.slice(0, 1).map((r) => r.url)) });
return pages.urls.map((u) => ({ url: u.url, chars: u.content.length, error: u.error }));
```

`get_search_content`는 저장된 본문을 `offset`/`limit`(기본·최대 30,000자)으로 잘라 돌려주고, 더 남았으면 다음 `offset`을 안내합니다. `findText`(문자열 또는 최대 10개 배열)를 주면 본문 전체를 읽지 않고 일치 구절과 앞뒤 문맥만 돌려줍니다. `findMode`는 `exact`, `case-insensitive`(기본), `fuzzy`이고, 출력은 20,000자로 제한되며 매치 수가 함께 표시됩니다. `findText`와 `offset`/`limit`을 같이 주거나 `findText` 없이 `findMode`만 주면 에러입니다.

```
get_search_content({ responseId: "abc123", urlIndex: 0, offset: 30000 })
get_search_content({ responseId: "abc123", urlIndex: 0, findText: ["timeout", "retry"], findMode: "fuzzy" })
```

## 설정

설정 없이 키 없는 Exa MCP로 동작합니다(Codex 구독 OpenAI 검색은 `/login`만 있으면 되고 설정이 필요 없습니다). 무료 한도를 넘기면 Exa API 키를 넣습니다.

- 환경 변수 `EXA_API_KEY`
- 또는 `~/.pi/web-search.json`

```json
{
  "exaApiKey": "...",
  "openaiSearchModel": "gpt-5.4",
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

로컬 개발 서버(`http://localhost:3000` 등)와 사설망 URL은 기본으로 막힙니다. 열려면 `ssrf.allowRanges`에 해당 대역을 넣습니다. 루프백은 `"127.0.0.0/8"`(또는 `"::1/128"`)이고, 이 대역이 들어 있으면 `localhost`와 `*.localhost`의 하드 차단이 풀립니다. 사설망은 `"10.0.0.0/8"`, `"192.168.0.0/16"` 같은 CIDR을 적습니다. 차단 에러 메시지에도 같은 방법이 안내됩니다. 예외로 열린 내부 주소는 Jina Reader 폴백으로 보내지 않습니다. `ssrf.allowRanges`로 연 대역(예: fake-IP 프록시의 `198.18.0.0/15`)으로 해석되는 호스트도 같은 이유로 Jina Reader 폴백을 쓰지 않습니다. `localhost`/`*.localhost`는 DNS로 풀린 주소가 허용 대역에 실제로 속할 때만 열립니다(`::1/128`만 허용했는데 IPv4로 풀리면 막힘). `ssrf`와 `fetchContent.domainPolicy` 설정은 프로세스 단위로 캐시되므로 수정한 뒤에는 Pi를 재시작(또는 `/reload`)해야 반영됩니다.

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

- 검색 provider는 Exa(키 또는 키 없는 MCP)와, Pi `/login`으로 로그인한 Codex 구독 OpenAI(원본의 `openai-search`)만 남겼습니다. OpenAI는 `openaiApiKey`/`OPENAI_API_KEY`, `openaiResponsesUrl` 게이트웨이, provider baseUrl 재사용, alpha search, 현재 모델 직접 검색, Kimi를 가져오지 않았고 Codex 엔드포인트로만 요청합니다. 원본의 `auto` 라우팅은 `openai-codex` 모델일 때 OpenAI, 실패하면 Exa로 단순화했습니다.
- 실패한 호출을 `isError: true`로 표시합니다(원본 0.37.0).
- `fetch_content`가 HTTP 요청에서 `text/markdown`을 먼저 요청합니다(원본 0.36.0). 서버가 `text/markdown`·`text/x-markdown`으로 답하면 Readability를 거치지 않고 본문을 그대로 씁니다. 500자 미만의 짧은 마크다운은 브라우저 Accept 헤더로 한 번 더 요청합니다.
- `fetch_content`에 `mode: "raw"`를 추가했습니다(원본). 원본의 `answer` 모드와 `auth` 프로필은 가져오지 않았습니다.
- 추출 텍스트의 인라인 `data:` URI를 길이가 들어간 생략 표시로 바꿉니다(원본의 `data-uri-sanitize`). 원본과 같이 `raw` 모드는 제외합니다.
- 직접 fetch에 SSRF 가드와 `fetchContent.domainPolicy`를 넣었습니다(원본의 `ssrf-protection`). 이 fork에는 프록시 경로가 없어 `ssrf.trustEnvProxy`와 프록시 관련 처리는 가져오지 않았고, `ssrf.allowRanges`만 남겼습니다.
- GitHub PR·이슈 URL을 `gh api`로 가져와 렌더합니다(원본의 `github-issue-pr`). 원본의 `gh pr view --json` 필드 조합, REST 폴백, 체크 롤업·연결된 이슈 표시는 가져오지 않았습니다. `gh`가 실패하면 일반 HTTP 추출로 넘어갑니다. 끄려면 `githubPrIssue.enabled: false`입니다.
- `web_search`에 Exa `category`를 추가했습니다(원본 0.36.0). 원본처럼 목록으로 제한하지 않고 문자열을 그대로 넘깁니다. API 키가 있으면 요청 body의 `category`로, 키 없는 MCP 경로는 필터를 받지 못하므로 쿼리 텍스트 뒤에 덧붙입니다. 원본의 MCP 고급 도구 시도는 가져오지 않았습니다.
- `fetch_content` 전문을 `web-search-cache` 디스크 캐시에 저장하고 세션에는 참조만 남깁니다(원본 `storage.ts`). 원본의 research 결과 저장과, 여러 세션이 한 프로세스에서 같은 결과를 공유할 때 쓰는 holder 계수는 가져오지 않았습니다.
- `get_search_content`에 `offset`/`limit`/`findText`/`findMode`를 추가했습니다(원본의 `content-find`). 검색 결과와 fetch 본문 모두에 적용되고, 원본의 research artifact 페이징과 검색 결과 페이지의 continuation 예산 계산은 가져오지 않았습니다.
- Pi `codemode` 스크립트에 `web_search`·`fetch_content`의 구조화된 결과를 돌려줍니다(원본 0.37.0). 스크립트가 부른 `web_search`의 `includeContent`는 완료를 기다립니다. 원본의 `outputSchema`에 있던 `providers`, `mimeType`, `status` 필드는 이 fork에 해당 데이터가 없어 뺐고, MCP 서버 쪽 구조화 출력도 없습니다.
- Gemini·Perplexity·브라우저 쿠키 기반 경로를 제거했습니다.
- 라이선스는 원본 MIT 표기를 유지합니다. `LICENSE`를 참고하세요.
