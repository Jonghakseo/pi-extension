# skill-creator 최초 설정

스킬 문서 작성은 설정 없이 된다. `scripts/validate_skill.py` 검증만 `python3`가 필요하다.

## 1. 확인

```bash
python3 --version
```

버전이 나오면 설정할 것이 없다. 3번으로 넘어간다.

## 2. 설치 (1회)

macOS에서 둘 중 하나를 실행한다.

```bash
xcode-select --install   # Command Line Tools에 포함된 python3
brew install python      # Homebrew를 쓰는 경우
```

Linux는 배포판 패키지를 쓴다.

```bash
sudo apt install python3   # Debian, Ubuntu, WSL
sudo dnf install python3   # Fedora, RHEL
```

검증 스크립트는 표준 라이브러리만 쓰므로 `pip` 패키지는 필요 없다. PyYAML이 이미 설치돼 있으면 그쪽을 쓰고, 없으면 내장 파서로 같은 검사를 한다.

## 3. 동작 확인

스크립트는 스킬 디렉터리 기준 절대 경로로 실행한다. 자기 자신을 대상으로 한 번 돌려 본다.

```bash
SKILL_DIR="<이 스킬 디렉터리>"
python3 "$SKILL_DIR/scripts/validate_skill.py" "$SKILL_DIR"
```

`OK: skill passed validation checks`가 나오면 정상이다. 경고가 있는 스킬은 `OK with warnings (N)`으로 끝나고 종료 코드는 0이다. 에러가 있으면 종료 코드가 1이다.

## python3를 설치할 수 없을 때

검증을 건너뛰고 [pi-skill-checklist.md](pi-skill-checklist.md)로 수동 점검한다. 프론트매터 필수 필드, 이름 규칙, 길이 제한, 참조 경로 존재 여부를 눈으로 확인한 뒤 "자동 검증 없이 체크리스트로 확인했다"고 보고한다.
