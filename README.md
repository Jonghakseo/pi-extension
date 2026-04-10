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

## Local install examples

```bash
pi install /Users/creatrip/Documents/pi-extension/packages/ask-user-question
pi install /Users/creatrip/Documents/pi-extension/packages/auto-name
pi install /Users/creatrip/Documents/pi-extension/packages/clipboard
pi install /Users/creatrip/Documents/pi-extension/packages/codex-fast-mode
pi install /Users/creatrip/Documents/pi-extension/packages/delayed-action
pi install /Users/creatrip/Documents/pi-extension/packages/generative-ui
pi install /Users/creatrip/Documents/pi-extension/packages/idle-screensaver
pi install /Users/creatrip/Documents/pi-extension/packages/todo-write
```

## npm publish flow

Publish each package from its own directory:

```bash
cd packages/ask-user-question && npm publish
cd packages/auto-name && npm publish
cd packages/clipboard && npm publish
cd packages/codex-fast-mode && npm publish
cd packages/delayed-action && npm publish
cd packages/generative-ui && npm publish
cd packages/idle-screensaver && npm publish
cd packages/todo-write && npm publish
```

After publish, users can install with:

```bash
pi install npm:@jonghakseo/pi-extension-ask-user-question
pi install npm:@jonghakseo/pi-extension-auto-name
pi install npm:@jonghakseo/pi-extension-clipboard
pi install npm:@jonghakseo/pi-extension-codex-fast-mode
pi install npm:@jonghakseo/pi-extension-delayed-action
pi install npm:@jonghakseo/pi-extension-generative-ui
pi install npm:@jonghakseo/pi-extension-idle-screensaver
pi install npm:@jonghakseo/pi-extension-todo-write
```

> npm package/scope names should be lowercase, so the scope is set to `@jonghakseo`.
