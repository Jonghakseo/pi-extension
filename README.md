# pi-extension monorepo

Standalone pi extensions managed in one repository and published as separate npm packages.

## Structure

```text
packages/
  ask-user-question/
  auto-name/
  clipboard/
  codex-fast-mode/
  delayed-action/
  generative-ui/
  idle-screensaver/
  todo-write/
  until/
```

## Workspace

This repository uses pnpm workspaces for local management and npm-compatible package manifests for publishing.

## Quality gates

This monorepo uses Biome as the single formatter/linter and Vitest for automated tests.

```bash
pnpm run biome:check
pnpm run typecheck
pnpm run test
pnpm run verify
```

- `pnpm run biome:check`: format, lint, and import-order validation with Biome
- `pnpm run typecheck`: TypeScript validation with `tsc --noEmit`
- `pnpm run test`: run all extension tests with Vitest
- `pnpm run verify`: run the full pre-publish gate (`biome + typecheck + test + workspace check`)

## Install from npm

```bash
pi install npm:@ryan_nookpi/pi-extension-ask-user-question
pi install npm:@ryan_nookpi/pi-extension-auto-name
pi install npm:@ryan_nookpi/pi-extension-clipboard
pi install npm:@ryan_nookpi/pi-extension-codex-fast-mode
pi install npm:@ryan_nookpi/pi-extension-delayed-action
pi install npm:@ryan_nookpi/pi-extension-generative-ui
pi install npm:@ryan_nookpi/pi-extension-idle-screensaver
pi install npm:@ryan_nookpi/pi-extension-todo-write
pi install npm:@ryan_nookpi/pi-extension-until
```
