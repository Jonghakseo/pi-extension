# enhanced-bash

![enhanced-bash: A bash tool with UI titles that moves commands outliving their timeout to the background.](./cover.svg)

Replaces pi's built-in `bash` tool. Every call carries a short `title` for the UI, and a command can run in the background either on request or when it outlives its timeout. It combines the `bash` override from [my-pi](https://github.com/Jonghakseo/my-pi) with [`bash-async`](../bash-async).

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-enhanced-bash
```

Do not load this package alongside `bash-async` or another extension that registers `bash`.

## Tools

### `bash`

| Parameter | Description |
| --- | --- |
| `command` | Command to run. |
| `title` | Short summary shown in the UI, written in the user's language. A missing title falls back to the command's first word. |
| `timeout` | Seconds. In the foreground, how long to wait before the command moves to the background (default 300). With `runInBackground`, how long the job may run (default 3,600). `0` removes the limit. |
| `runInBackground` | Start a background job instead of waiting. Defaults to `false`. |

A foreground command runs through pi's built-in bash tool, so streaming, output truncation, and error text match the built-in. When it is still running at its timeout, it is not killed. It becomes a background job, the tool returns the job ID and the last 20 lines printed so far, and the command may keep running for up to 3,600 more seconds.

A background start waits up to 10 seconds. A command that finishes by then returns its final status and output inline and is not reported again. A longer one keeps running, and its result arrives automatically as a steer message once the current response and its tool calls finish. Every background result includes a log path; read it if early output is needed instead of polling.

TUI programs, REPLs, and commands requiring stdin are unsupported in the background.

### `bash_stop`

Stops a background job by `jobId`. A stopped job is not reported again. A job that already finished on its own keeps its completion message.

## Shell and macOS

Commands run in the shell pi would use, with pi's global `shellPath` and `shellCommandPrefix` settings applied. Project-level shell settings apply only when pi trusts the project, so a cloned repository cannot choose which binary runs your commands. On macOS with no `shellPath` configured, a Homebrew bash (`/opt/homebrew/bin/bash` or `/usr/local/bin/bash`) replaces the system's bash 3.2, so `mapfile`, `readarray`, and associative arrays work. Set `PI_ENHANCED_BASH_SHELL` to choose a shell explicitly; `/bin/bash` restores pi's default.

On macOS the tool description also lists the GNU habits that fail with BSD tools, such as `sed -i` without a suffix, `timeout`, `grep -P`, and `head -n 0`. When a foreground or background command fails with one of these known BSD errors, the result ends with a `[macOS hint]` line naming the BSD form. Commands are never rewritten.

## Limits and retention

- Up to four background jobs started with `runInBackground` run at once; more wait in a queue. Set `PI_ENHANCED_BASH_MAX_CONCURRENCY` to change the limit. Commands that move to the background from the foreground do not wait, but each occupies one of these slots while it runs.
- The background start window is 10 seconds. Set `PI_ENHANCED_BASH_SYNC_WINDOW_MS` to another value up to 60,000, or to `0` to always return immediately.
- At most 20 active or queued jobs are retained.
- Job logs are written under the operating system's temporary directory in `pi-enhanced-bash`, kept for up to 24 hours, and share a 1 GiB quota. Each log stops at 20 MiB.
- Pi session shutdown stops active jobs. Jobs do not continue across a Pi restart.
