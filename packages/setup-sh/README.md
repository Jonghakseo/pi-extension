# @ryan_nookpi/pi-extension-setup-sh

Automatically runs `setup.sh` from the current pi working directory when a session starts.

This is useful for repositories that need a predictable bootstrap step before the agent starts editing, testing, or running commands.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-setup-sh
```

## What it does

- looks for `setup.sh` only in the current working directory
- runs `setup.sh` automatically on session startup
- skips automatic reruns when the same `setup.sh` already completed successfully
- keeps a single `/setup-sh` command for manual control
- shows running, pending, failed, cancelled, and stale states in the pi UI
- keeps per-project logs and state under pi's setup-sh state directory
- prevents duplicate setup runs with a lock file

## Command

```text
/setup-sh
```

`/setup-sh` is a toggle-style command:

- if no setup run exists yet, it starts `./setup.sh`
- if setup is currently running, it aborts the active run
- if setup already finished, it reruns `./setup.sh`

No subcommands are registered.

## Behavior

- `setup.sh` is executed with `/bin/zsh` from the current working directory.
- A successful automatic run is remembered by the script hash, so changing `setup.sh` allows it to run again.
- Long-running setup output becomes `pending` in the UI when logs have been idle for a while.
- Failed and stale states stay visible and can be rerun with `/setup-sh`.
- If the current directory does not contain `setup.sh`, `/setup-sh` reports that it was not found in the current folder.

## Requirements

- pi
- a readable `setup.sh` file in the current pi working directory
