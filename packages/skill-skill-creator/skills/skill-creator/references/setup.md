# skill-creator 최초 설정

스킬 문서 작성은 설정 없이 된다. `scripts/validate_skill.py` 검증만 `python3`가 필요하다.

## 확인

```bash
python3 --version
```

버전이 나오면 설정할 것이 없다.

## 설치 (1회)

macOS에서 둘 중 하나를 실행한다.

```bash
xcode-select --install   # Command Line Tools에 포함된 python3
brew install python      # Homebrew를 쓰는 경우
```

검증 스크립트는 표준 라이브러리만 쓰므로 `pip` 패키지는 필요 없다.
