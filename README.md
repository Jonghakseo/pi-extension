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
```

## Workspace

This repository uses pnpm workspaces for local management and npm-compatible package manifests for publishing.

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
```
