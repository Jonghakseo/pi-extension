# bash-async

Bounded background shell jobs for finite, non-interactive commands in [pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-bash-async
```

Do not load this package alongside another extension that registers `bash_async`.

## Tool interface

The extension registers the `bash_async` tool with five actions:

- `start`: launch a finite command in the background
- `status`: inspect one job
- `output`: read retained job output
- `kill`: stop a queued or running job
- `list`: list retained jobs

Use `start` when the next action does not need the command result immediately. Completion or failure arrives automatically through a follow-up message, so do not poll `status`, `output`, or `list`, and do not run sleep loops while waiting. Query output only when an early result is useful or the user asks for it.

TUI programs, REPLs, commands requiring stdin, and selection menus are unsupported.

## Limits and retention

- Commands time out after 1,800 seconds by default. Set `timeout` to `0` to disable the timeout.
- Up to four jobs run concurrently by default. Set `PI_BASH_ASYNC_MAX_CONCURRENCY` to a positive integer to change the limit.
- The extension retains at most 20 active or queued jobs.
- Closed logs are stored under the operating system's temporary directory, normally in `pi-bash-async`, and retained for up to 24 hours.
- Closed logs share a 1 GiB quota. Older closed logs may be pruned before 24 hours when the quota is exceeded.
- Pi session shutdown aborts active jobs, settles them, and clears the running-jobs widget. Jobs do not continue across Pi shutdown.
