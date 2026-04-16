# pi-extension monorepo

Standalone pi extensions managed in one repository and published as separate npm packages.

## Structure

```text
packages/
  ask-user-question/
  auto-name/
  cc-system-prompt/
  claude-hooks-bridge/
  claude-mcp-bridge/
  clipboard/
  codex-fast-mode/
  cross-agent/
  delayed-action/
  generative-ui/
  idle-screensaver/
  memory-layer/
  open-pr/
  todo-write/
  until/
```

## Workspace

This repository uses pnpm workspaces for local management and npm-compatible package manifests for publishing.

## Quality gates

This monorepo uses Biome as the single formatter/linter, Vitest for automated tests, and Lefthook for local Git hooks.

```bash
pnpm run biome:check
pnpm run biome:strict
pnpm run typecheck
pnpm run test
pnpm run coverage:check
pnpm run verify
pnpm run verify:strict
```

- `pnpm run biome:check`: format, lint, and import-order validation with Biome
- `pnpm run biome:strict`: same as `biome:check`, but fails on warnings via Biome CLI `--error-on-warnings`
- `pnpm run typecheck`: TypeScript validation with `tsc --noEmit`
- `pnpm run test`: run all extension tests with Vitest
- `pnpm run coverage:check`: run Vitest coverage with 100% thresholds and per-file enforcement for the covered package sources
- `pnpm run verify`: legacy pre-publish gate (`biome + typecheck + test + workspace check`)
- `pnpm run verify:strict`: strict gate (`biome:strict + typecheck + test + workspace check + coverage:check`)

## Git hooks

`pnpm install` runs the Lefthook `prepare` script (`lefthook install --reset-hooks-path`) and installs local hooks automatically from `lefthook.yml`, clearing an old Husky `core.hooksPath` during migration.

- `pre-commit`: `pnpm run precommit:strict`
  - `biome check --staged --error-on-warnings`
  - `pnpm run typecheck`
  - `pnpm run test`
- `pre-push`: `pnpm run prepush:strict`
  - `pnpm run verify:strict`

You can also validate and invoke the configured hooks manually with:

```bash
pnpm exec lefthook validate
pnpm exec lefthook run pre-commit
pnpm exec lefthook run pre-push
```

Coverage is enforced with Vitest's per-file 100% thresholds for the deterministic source modules listed in `vitest.config.ts`:

- `packages/auto-name/utils/**/*.ts`
- `packages/clipboard/index.ts`
- `packages/codex-fast-mode/index.ts`
- `packages/generative-ui/{guidelines.ts,html-utils.ts,svg-styles.ts}`

Interactive/runtime-heavy extension entrypoints remain validated by the normal test suite in `pnpm run test`, but are intentionally outside the strict coverage gate.

## Install from npm

```bash
pi install npm:@ryan_nookpi/pi-extension-ask-user-question
pi install npm:@ryan_nookpi/pi-extension-auto-name
pi install npm:@ryan_nookpi/pi-extension-cc-system-prompt
pi install npm:@ryan_nookpi/pi-extension-claude-hooks-bridge
pi install npm:@ryan_nookpi/pi-extension-claude-mcp-bridge
pi install npm:@ryan_nookpi/pi-extension-clipboard
pi install npm:@ryan_nookpi/pi-extension-codex-fast-mode
pi install npm:@ryan_nookpi/pi-extension-cross-agent
pi install npm:@ryan_nookpi/pi-extension-delayed-action
pi install npm:@ryan_nookpi/pi-extension-generative-ui
pi install npm:@ryan_nookpi/pi-extension-idle-screensaver
pi install npm:@ryan_nookpi/pi-extension-memory-layer
pi install npm:@ryan_nookpi/pi-extension-open-pr
pi install npm:@ryan_nookpi/pi-extension-todo-write
pi install npm:@ryan_nookpi/pi-extension-until
```
