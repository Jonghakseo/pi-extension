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

From the cloned repository root:

```bash
pi install ./packages/ask-user-question
pi install ./packages/auto-name
pi install ./packages/clipboard
pi install ./packages/codex-fast-mode
pi install ./packages/delayed-action
pi install ./packages/generative-ui
pi install ./packages/idle-screensaver
pi install ./packages/todo-write
```

## npm publish flow

Use the workspace scripts from repo root:

```bash
pnpm run publish:dry-run
pnpm run publish:all
pnpm run publish:ask-user-question
pnpm run publish:generative-ui
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
