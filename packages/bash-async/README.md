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

`start` waits up to a sync window, 10 seconds by default, before returning. A command that finishes within the window returns its final status and the last lines of its output inline, up to 200 lines and 8 KiB, and is not reported again. When earlier lines are left out, the result says how many and where the full log is. Interrupting the tool call during the window kills the job. A command still running when the window ends keeps running in the background. A job queued behind the concurrency limit returns immediately without waiting.

Use `start` when the next action does not depend on a possibly long result. Results arrive automatically, so do not poll `status`, `output`, or `list`, and do not run sleep loops while waiting. Completions are batched for 500 ms and then sent even while the agent is busy. A success is queued as a follow-up and arrives after the current agent run ends. A failure or timeout is sent as a steer message, so the agent sees it at the next tool boundary and can change course. A job stopped by `kill` is not reported; calling `kill` on a job that already finished does not suppress its result. Query output only when an early result is useful or the user asks for it. Reading the final output within the 500 ms batch drops the completion message; later reads do not, so you may see the result twice. A repeated `status`, `output`, or `list` query that would return the same information as the previous one fails with a rate-limit error until the job state changes or the cooldown expires.

TUI programs, REPLs, commands requiring stdin, and selection menus are unsupported.

## Limits and retention

- Commands time out after 1,800 seconds by default. Set `timeout` to `0` to disable the timeout.
- Up to four jobs run concurrently by default. Set `PI_BASH_ASYNC_MAX_CONCURRENCY` to a positive integer to change the limit.
- The start sync window is 10 seconds. Set `PI_BASH_ASYNC_SYNC_WINDOW_MS` to another value up to 60,000, or to `0` to always return immediately.
- The poll cooldown is 10 seconds. Set `PI_BASH_ASYNC_POLL_COOLDOWN_MS` to another value, or to `0` to disable rate limiting.
- The extension retains at most 20 active or queued jobs.
- Closed logs are stored under the operating system's temporary directory, normally in `pi-bash-async`, and retained for up to 24 hours.
- Closed logs share a 1 GiB quota. Older closed logs may be pruned before 24 hours when the quota is exceeded.
- Pi session shutdown aborts active jobs, settles them, and clears the running-jobs widget. Jobs do not continue across Pi shutdown.
