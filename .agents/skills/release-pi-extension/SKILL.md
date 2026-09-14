---
name: release-pi-extension
description: pi-extension 모노레포의 개별 패키지를 npm에 배포하고 필요 시 커밋과 Git push까지 검증한다. 사용자가 이 레포에서 "배포해줘", "npm publish", "패키지 릴리스", "버전 올리고 배포", "커밋+배포+푸시"처럼 실제 release를 명시적으로 요청할 때 사용한다. 일반 commit/push만 요청하면 ship을 사용한다.
compatibility: pnpm workspace, npm registry 접근, git, macOS 또는 Linux. 대화형 npm 인증에는 tmux-terminal helper가 필요하다.
---

# release-pi-extension

pi-extension의 **단일 패키지 release**를 안전하게 수행한다. npm publish와 push는 외부 쓰기이므로 사용자가 명시적으로 요청한 범위까지만 진행한다.

## 범위

- 이 저장소의 `packages/*` 중 정확히 한 패키지를 release한다.
- 일반 commit/push만 요청받으면 `ship`을 사용한다.
- 여러 패키지 동시 배포는 자동으로 확대하지 않는다. 사용자가 대상을 명시하지 않았고 변경 패키지가 하나로 결정되지 않으면 먼저 확인한다.
- force push, 이미 존재하는 npm 버전 재배포, 확인 없는 `publish:all`은 금지한다.

## Workflow

### 1. Release 대상과 권한 고정

1. git root가 pi-extension인지 확인한다.
2. 변경 파일과 root `package.json`의 `publish:<slug>` scripts를 읽어 대상 패키지 하나를 결정한다.
3. 패키지 `name`, 현재 `version`, publish script slug를 기록한다.
4. 사용자 요청에서 허용된 외부 쓰기를 구분한다.
   - publish가 명시되지 않았으면 실제 npm publish를 하지 않는다.
   - push가 명시됐으면 release 검증 뒤 non-force push까지 진행한다.
   - push가 명시되지 않았으면 npm 등록 확인 뒤 한 번만 물어본다.

### 2. 버전과 package metadata 준비

1. 기본은 patch bump다. peer 구조나 공개 동작 변경이면 minor가 더 맞는지 검토하고, 모호하면 사용자에게 확인한다.
2. 새 peer를 추가했다면 `peerDependenciesMeta`의 모든 peer가 `{ "optional": true }`인지 확인한다. 글로벌 설치에서 npm 7+의 peer 자동 설치가 플랫폼별 오류를 만들 수 있다.
3. 아래 명령으로 같은 name/version이 이미 존재하는지 확인한다. 존재하면 publish를 중단한다.

```bash
npm view "<package-name>@<version>" version
```

### 3. 변경 검증

```bash
pnpm run verify:strict
```

다음을 모두 확인한다.

- Biome strict
- TypeScript typecheck
- 전체 테스트
- workspace package 검사
- coverage gate

실패하면 publish와 push를 중단한다. 관련 없는 실패를 임의 수정하지 않는다.

### 4. npm 인증

먼저 비대화형으로 확인한다.

```bash
npm whoami
```

401 또는 미인증이면 `tmux-terminal` skill을 읽고 전용 PTY에서 `npm login`을 실행한다.

1. `doctor` 성공을 확인한다.
2. tmux session에서 `npm login`을 시작한다.
3. 화면을 capture한 뒤 prompt를 확인하고 Enter를 보낸다.
4. 브라우저를 연 뒤 사용자의 "완료" 응답을 기다리지 않는다. 같은 turn에서 5~10초 간격, 최대 10분의 bounded loop로 pane 상태를 계속 확인한다. 중간 상태 보고 때문에 loop를 중단하거나 turn을 끝내지 않는다.
5. pane 종료를 감지하면 즉시 `npm whoami`를 확인한다. 종료 코드와 무관하게 `npm whoami` 성공을 login 완료 기준으로 삼고, 실패하면 login 실패로 처리한다. 승인 prompt가 그대로 살아 있으면 Enter를 다시 보내지 않는다.
6. 10분 동안 pane이 계속 대기 중일 때만 현재 prompt를 capture하고 사용자에게 브라우저 승인을 요청한다. task는 `in_progress`로 유지하고, 다음 turn에서는 다른 입력 전에 기존 pane 상태부터 확인한다.
7. `npm whoami` 성공 또는 명시적 중단이 확인된 뒤에만 login session을 cleanup한다.

npm 공식 문서상 `npm login`의 기본 `auth-type`은 `web`이며 자격 증명을 npmrc에 저장한다.

### 5. 정확한 단일 패키지 dry-run

root의 전체 패키지 dry-run 대신 package name으로 정확히 필터링한다.

```bash
pnpm --filter "<package-name>" publish --dry-run --access public --no-git-checks
```

출력에서 다음을 확인한다.

- package name과 목표 version
- tarball files
- public access
- 의도하지 않은 파일이나 다른 workspace가 없음

npm 공식 문서상 `--dry-run`은 변경 없이 publish가 할 일을 보고하고, 동일 name/version은 재사용할 수 없다.

### 6. Commit

사용자가 commit을 요청했으면 의도 단위로 커밋한다.

1. `git diff --check`, `git status`, diff를 확인한다.
2. 코드, 테스트, 문서, package version을 같은 release 의도 커밋으로 묶는다.
3. pre-commit hook 실패 시 publish를 중단한다.
4. amend와 force 동작은 하지 않는다.

### 7. 실제 publish

실제 publish는 npm 2FA 또는 browser approval이 나타날 수 있으므로 `tmux-terminal`에서 root script를 실행한다.

```bash
pnpm run "publish:<slug>"
```

- package별 script가 없으면 임의로 `publish:all`을 대신 실행하지 않는다.
- root publish script가 `verify:strict`를 다시 실행하는 것은 release gate로 유지한다.
- npm이 별도 publish 승인을 요구하면 capture한 prompt를 기준으로 처리한다.

#### Browser approval과 완료 자동 감지

1. Enter를 보내기 전에 capture하여 일회성 승인 URL을 확보한다.
2. 최초 prompt에는 Enter를 한 번만 보낸다.
3. 브라우저를 연 뒤 사용자에게 완료 보고를 요구하거나 turn을 끝내지 않는다. 같은 turn에서 5~10초 간격, 최대 10분의 bounded loop로 pane의 종료 여부를 계속 확인한다.
4. pane이 종료 코드 0으로 끝나면 바로 Registry 실물 검증으로 넘어간다. 사용자의 "done" 또는 "승인 완료" 메시지는 필요하지 않다.
5. spinner가 살아 있으면 Enter를 반복 전송하지 않는다. 사용자가 페이지 재오픈을 요청하거나 browser가 열리지 않은 정황이 있을 때만 pane을 다시 capture하고, 캡처한 URL을 OS opener로 직접 연다.
6. 10분 동안 pane이 계속 대기 중일 때만 사용자에게 승인을 요청한다. task와 pane을 유지하고, 다음 turn에서는 다른 입력 전에 기존 pane 상태부터 확인한다. pane이 비정상 종료되면 publish가 수락된 뒤 응답만 끊겼을 가능성이 있으므로, 목표 버전을 Registry에서 10초 간격으로 최대 3분 확인한다. 전체 확인 구간에도 버전이 없을 때만 동일 worktree에서 재시도한다.

```bash
# macOS
open '<captured-auth-url>'

# Linux
xdg-open '<captured-auth-url>'
```

일회성 URL은 최종 응답, 커밋, 로그 요약에 복사하지 않는다. 승인 후 pane 종료를 자동 감지하고, 종료 코드 0 또는 목표 버전의 bounded Registry 확인으로 publish 성공을 판정한다.

### 8. Registry 실물 검증

publish 성공 문구만 믿지 않는다. 목표 version을 registry에서 다시 읽는다.

```bash
npm view "<package-name>@<version>" version
```

출력이 목표 version과 정확히 같아야 npm 배포 완료로 판정한다. publish가 종료 코드 0이어도 Registry 반영이 늦을 수 있으므로 10초 간격, 최대 3분까지 bounded retry한다. npm의 `Your package is being processed` 안내는 이 구간에서 실패로 판정하지 않는다. `npm view`는 registry의 package metadata를 출력한다.

peer 변경이 있거나 사용자가 설치 검증을 요청했다면 글로벌 재설치 후 패키지 내부에 중첩 `node_modules`가 생기지 않는지 확인한다. 생기면 optional peer 누락을 의심한다.

### 9. Git push와 remote 검증

사용자가 push를 명시했거나 registry 검증 뒤 승인했을 때만 진행한다.

```bash
git push -u origin "$(git branch --show-current)"
```

- force push하지 않는다.
- pre-push strict hook이 실패하면 중단한다.
- push 후 local HEAD와 remote branch SHA를 직접 비교한다.

```bash
git rev-parse HEAD
git ls-remote origin "refs/heads/$(git branch --show-current)"
```

두 SHA가 일치해야 push 완료로 판정한다.

### 10. Cleanup과 최종 보고

1. 이 작업에서 만든 tmux owner session을 모두 cleanup한다.
2. git worktree 상태를 확인한다.
3. 아래 실물만 보고한다.
   - npm package와 version
   - commit SHA
   - remote branch와 SHA 일치 여부
   - strict test/coverage 결과
   - 건너뛴 검증 또는 남은 위험

## 실패 처리

- npm login 실패: publish하지 않고 인증 단계에서 중단한다.
- 목표 version이 이미 존재: version 재사용을 시도하지 않는다.
- publish 성공, push 실패: npm은 이미 배포됐음을 분명히 알리고 push만 실패로 남긴다.
- publish pane이 대기 중: capture 없이 키를 보내지 않는다. 브라우저를 연 뒤에는 bounded loop로 완료를 자동 감지하고, 사용자 응답은 요구하지 않는다.
- publish가 `EOTP`로 비대화형 종료됨: shared worktree 상태를 확인하고 Registry를 10초 간격으로 최대 3분 조회한다. 목표 버전이 끝까지 없을 때만 `tmux-terminal`에서 같은 package-specific script를 재실행한다.
- Registry 반영 지연: 최대 3분간 자동 재조회한 뒤에만 실패로 판정한다.
- 사용자의 외부 쓰기 승인이 모호함: publish 또는 push 직전에 확인한다.

## Validation

완료 전 체크한다.

- [ ] 정확히 한 package와 `publish:<slug>`를 선택했다.
- [ ] 목표 version이 registry에 없음을 publish 전에 확인했다.
- [ ] `verify:strict`가 통과했다.
- [ ] `npm whoami`가 성공했다.
- [ ] package-specific dry-run tarball을 확인했다.
- [ ] 브라우저 승인 뒤 사용자 완료 응답 없이 publish pane 종료를 자동 감지했다. status가 0이 아니거나 불명확하면 bounded Registry 확인으로 실제 성공 여부를 판정했다.
- [ ] `npm view <name>@<version> version`이 목표 version을 반환했다. 반영 지연 시 bounded retry했다.
- [ ] 요청된 경우 non-force push 후 local/remote SHA가 일치했다.
- [ ] tmux session을 cleanup했다.

## Official references

- Agent Skills specification: <https://agentskills.io/specification>
- npm login: <https://docs.npmjs.com/cli/v11/commands/npm-login>
- npm publish: <https://docs.npmjs.com/cli/v11/commands/npm-publish>
- npm view: <https://docs.npmjs.com/cli/v11/commands/npm-view>
