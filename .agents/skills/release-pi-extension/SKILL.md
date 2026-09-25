---
name: release-pi-extension
description: pi-extension 모노레포의 개별 패키지를 npm에 배포하고 필요 시 커밋과 Git push까지 검증한다. 사용자가 이 레포에서 "배포해줘", "npm publish", "패키지 릴리스", "버전 올리고 배포", "커밋+배포+푸시"처럼 실제 release를 명시적으로 요청할 때 사용한다. 일반 commit/push만 요청하면 ship을 사용한다.
compatibility: pnpm workspace, npm registry 접근, Node.js와 Python 3, macOS 또는 Linux. 브라우저에서 npm 로그인 및 게시 승인이 가능해야 한다.
---

# release-pi-extension

이 저장소의 패키지 하나를 npm에 배포한다. npm publish와 push는 외부 쓰기이므로 사용자 요청 범위 밖으로 넓히지 않는다.

## 대상 확정

1. Git 루트가 `pi-extension`인지, 변경 파일이 어느 `packages/<slug>`에 속하는지 확인한다. 대상이 여러 개면 하나를 확인받는다.
2. 패키지의 `name`, `version`, peer의 `peerDependenciesMeta.*.optional`을 확인한다. 공개 계약이나 peer 변경으로 minor/major가 필요하면 **명령 실행 전에** 해당 버전을 준비한다. 자동 버전 변경은 기존 최신 버전에서 patch만 올린다.
3. npm 게시가 승인된 경우에만 아래 공통 명령을 실행한다. 사용자가 commit/push도 요청한 경우에는 게시 검증 뒤 별도로 `ship`을 따른다. publish만 요청했으면 commit/push하지 않는다.

## 원커맨드 배포

```bash
pnpm deploy <extension-name>  # 모든 packages/<extension-name>에 공통 (예: pnpm deploy memory-layer)
```

긴 작업이므로 bash 도구의 timeout을 최소 1,800초로 설정한다. 별도 `npm login`, `verify:strict`, `publish:<slug>`를 에이전트가 순서대로 호출하지 않는다. `scripts/deploy-package.mjs`가 전부 처리한다.

- `npm whoami`가 실패하고 재로그인이 필요한 경우 npm 웹 로그인 URL을 감지해 브라우저를 연다. 사용자에게 로그인 완료 메시지를 요구하지 않는다. 승인이 끝나면 `npm whoami`로 확인한다.
- 현재 버전이 이미 Registry의 `latest`라면 빈 patch 버전으로 올린다. 로컬 버전이 Registry의 `latest`보다 오래됐거나, 게시된 버전이 `latest`가 아니라면 멈춘다. 수동 minor/major 지정은 명령 실행 전에 한다.
- `pnpm run verify:strict`를 한 번 실행한다. 실패하면 게시하지 않는다.
- 정확한 패키지 하나의 `pnpm --filter <name> publish --dry-run --access public --no-git-checks`를 검사한 뒤 실제 게시한다. npm publish는 `scripts/deploy-pty.py`의 PTY에서 실행해 npm 웹 OTP 분기를 사용한다. 게시 승인이 필요하면 실제 URL을 자동으로 열고 npm CLI가 기다린다.
- `npm view <name>@<version> version`으로 Registry 실물을 최대 3분 재조회한다. 게시 프로세스가 실패하더라도 Registry 확인 전에는 같은 버전을 재시도하지 않는다.

브라우저가 열리지 않으면 명령 출력에 있는 일회성 URL을 사용자가 직접 열 수 있다. URL을 커밋·최종 보고에 복사하지 않는다. 로그인 및 게시 승인은 각각 최대 10분 기다린다. 실패 시 해당 단계의 오류를 보고하고, 원인을 해결한 뒤 **Registry의 버전 존재 여부를 확인하고** 다시 실행한다.

## 완료 확인

- 출력의 대상 패키지·버전과 Registry 조회가 일치하는지 확인한다.
- `git status --short`, `git diff --check`로 작업 트리를 확인한다. 새 버전의 `package.json`과 기존 변경을 임의로 버리거나 amend하지 않는다.
- push가 명시된 경우에만 non-force push 후 local/remote SHA를 비교한다.

## 공식 문서

- npm login: <https://docs.npmjs.com/cli/v11/commands/npm-login/>
- npm publish: <https://docs.npmjs.com/cli/v11/commands/npm-publish/>
- npm view: <https://docs.npmjs.com/cli/v11/commands/npm-view/>
