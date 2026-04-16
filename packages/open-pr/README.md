# open-pr

Open the current branch's pull request in your browser via [GitHub CLI](https://cli.github.com/).

## What it does

Registers a `/open-pr` command that:

1. Detects the current git branch
2. Looks up the associated PR using `gh pr view --json url`
3. Opens the PR URL in your default browser

Works on macOS (`open`), Linux (`xdg-open`), and Windows (`cmd /c start`).

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- A git repository with a remote

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-open-pr
```
