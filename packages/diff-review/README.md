# @ryan_nookpi/pi-extension-diff-review

A native diff review extension for pi.

It opens a dedicated review window for the current repository so you can inspect the branch diff, review individual commits, browse all changed files, and collect feedback before sending it back into the editor.

![diff-review screenshot](./assets/diff-review-screenshot.png)

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-diff-review
```

## What it does

- registers the `/diff-review` command
- opens a native review window for the current git repository
- supports branch, per-commit, and all-files review scopes
- detects local file changes while the review window is open and offers a manual refresh without polling
- lets you leave overall comments and file/line comments
- appends the collected feedback back into the pi editor as a follow-up prompt

## Choosing the base branch

By default the branch scope compares `HEAD` against the first base that resolves, in this order: the branch upstream (when it is not the same-named remote branch), `origin/HEAD`, `origin/main`, `origin/master`, `origin/develop`, `main`, `master`, `develop`.

To compare against something else:

- pick a branch from the **Base** dropdown in the review window header (`Auto` restores the default detection), or
- set the `DIFF_REVIEW_BASE` environment variable (for example `DIFF_REVIEW_BASE=origin/release-1.0 pi`) to change the default for new review windows. If the ref cannot be resolved, auto-detection is used.

## Requirements

- pi
- a git repository
- `glimpseui` runtime installed through the package dependency

## Inspiration

Inspired by [badlogic/pi-diff-review](https://github.com/badlogic/pi-diff-review).
