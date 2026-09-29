# 스켈레톤 작성 규칙

`version` 필드가 없는 요소는 스켈레톤으로 취급한다. 창이 열리면 앱이 공식 `convertToExcalidrawElements`(id 유지)로 정식 요소로 바꾸고 파일을 다시 저장한다. 그 뒤 파일에는 `version`, `seed`, `boundElements` 같은 필드가 붙는다. 스켈레톤과 정식 요소는 한 파일에 섞여 있어도 된다.

공식 문서: <https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton>

## 파일 뼈대

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "pi-excalidraw",
  "elements": [],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": 20 },
  "files": {}
}
```

## 도형과 라벨

`rectangle` / `ellipse` / `diamond`. 모든 도형에 의미 있는 `id`와 `x`, `y`, `width`, `height`를 준다. 화살표 자동 연결과 lint가 이 값에 의존한다.

```json
{ "type": "rectangle", "id": "api", "x": 100, "y": 100, "width": 200, "height": 72,
  "backgroundColor": "#a5d8ff", "fillStyle": "solid", "roundness": { "type": 3 },
  "label": { "text": "API 서버" } }
```

- `label`: `text`(필수), `fontSize`(기본 20), `strokeColor`, `textAlign`(`left|center|right`), `verticalAlign`(`top|middle|bottom`). 줄바꿈은 `\n`.
- `roundness: { "type": 3 }`: 모서리가 둥근 사각형. 생략하면 직각이다.

## 텍스트

```json
{ "type": "text", "id": "title", "x": 100, "y": 20, "text": "결제 흐름", "fontSize": 28 }
```

크기는 앱이 측정하니 `width`/`height`는 생략한다.

## 화살표와 선

가장 쉬운 형태는 좌표 없이 연결할 두 요소의 id만 적는 것이다. 앱이 두 도형의 중심을 잇고 가장자리에서 끊어 좌표를 계산한 뒤 바인딩한다.

```json
{ "type": "arrow", "id": "api-db", "start": { "id": "api" }, "end": { "id": "db" }, "label": { "text": "SQL" } }
```

직접 경로를 지정하려면 `x`, `y`와 상대 좌표 `points`를 준다. 꺾인 선은 점을 3개 이상 둔다.

```json
{ "type": "arrow", "id": "loop", "x": 300, "y": 136, "points": [[0,0],[60,0],[60,-120],[-100,-120]],
  "start": { "id": "b" }, "end": { "id": "a" } }
```

- `startArrowhead` / `endArrowhead`: `null | "arrow" | "triangle" | "bar" | "circle" | "diamond"`, ERD용 `"crowfoot_one" | "crowfoot_many" | "crowfoot_one_or_many"`. 화살표 기본값은 끝에만 `arrow`.
- 연결 없는 선: `{ "type": "line", "x": 0, "y": 400, "points": [[0,0],[800,0]], "strokeStyle": "dashed" }`
- 양방향: `"startArrowhead": "arrow"`

## 프레임(묶음 박스)

```json
{ "type": "frame", "id": "vpc", "name": "VPC", "children": ["api", "db"] }
```

frame 크기는 자식과 자식에 연결된 화살표까지 감싸도록 자동 계산된다(`x`/`y`/`width`는 무시). 그래서 frame 밖으로 이어지는 화살표가 있으면 frame이 그쪽으로 늘어난다. 그런 경우와 단순히 영역만 보여주려면 프레임 대신 큰 `rectangle`(배경 투명, `strokeStyle: "dashed"`)을 먼저 배치하고 안에 도형을 둔다. 완전히 감싸는 도형끼리의 포함 관계는 lint가 겹침으로 보지 않는다.

## 공통 스타일 속성

| 속성 | 값 |
|---|---|
| `strokeColor` / `backgroundColor` | hex 또는 `"transparent"` |
| `fillStyle` | `hachure`(기본, 빗금) · `cross-hatch` · `solid` · `zigzag` |
| `strokeWidth` | `1` · `2`(기본) · `4` |
| `strokeStyle` | `solid` · `dashed` · `dotted` |
| `roughness` | `0` 반듯함 · `1` 손그림(기본) · `2` 더 거칠게 |
| `opacity` | 0–100 |
| `fontFamily` | `5` Excalifont(기본, 손글씨, 한글 손글씨 폰트 지원) · `6` Nunito · `8` Comic Shanns · `3` Cascadia(코드) |

## 정식 요소를 고칠 때

- 이동: 도형의 `x`/`y`만 바꾼다. 안의 라벨과 연결된 직선 화살표는 앱이 다시 맞춘다.
- 라벨 텍스트: 도형을 스켈레톤으로 다시 쓰는 것이 가장 안전하다. `version`, `versionNonce`, `seed`, `boundElements`를 빼고 `id`, 좌표, 스타일, `label`만 남긴다. 기존 라벨 텍스트 요소는 앱이 지운다.
- 화살표 경로 초기화: 화살표를 `{ "type": "arrow", "id": "<같은 id>", "start": {"id": …}, "end": {"id": …} }`로 다시 쓴다. 라벨이 있었다면 `label`도 다시 넣는다.
