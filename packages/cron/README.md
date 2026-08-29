# cron extension

Persistent scheduler for Pi.

## Installation

Install the published package:

```bash
pi install npm:@ryan_nookpi/pi-extension-cron
```

Or load this package from a local checkout:

```bash
pi install ./packages/cron
```

Do not load a local copy and the npm package at the same time. Both register the `cron` tool and `/cron` command.

## Platform support

The scheduler is macOS-first. On macOS, its LaunchAgent keeps jobs running after login and reboot. On other platforms, `cron install-launchd` and `cron uninstall-launchd` return an unsupported result. You can still start the detached daemon manually with `cron start-daemon`, but it will not restart automatically after reboot.

## What it does

- Lets the agent register scheduled work from natural language.
- Stores each job as metadata plus a self-contained Markdown prompt.
- Runs jobs through a headless Pi process: `pi -p --no-session @prompt.md`.
- Extensions and MCP tools are loaded as in interactive mode so scheduled prompts can call MCP tools (Slack, Jira, etc.).
- Uses a detached daemon and macOS `launchd` LaunchAgent so jobs continue after Pi exits and after reboot/login.
- Keeps one-shot jobs as disabled history after they run.
- Deletes jobs immediately when `cron remove` or `/cron remove` is called. LaunchAgent uninstall still requires confirmation unless `cron uninstall-launchd --yes` is used.

## Files

```text
~/.pi/agent/cron/jobs.json
~/.pi/agent/cron/prompts/<jobId>.md
~/.pi/agent/cron/runs/<jobId>/<timestamp>.log
~/.pi/agent/cron/daemon.pid
~/.pi/agent/cron/daemon.log
~/Library/LaunchAgents/dev.pi.cron.plist
```

## Natural language examples

```text
방금 나랑 한 릴리즈 체크를 매일 아침 10시에 실행되게 해줘
2시간 뒤에 방금 정리한 QA 체크리스트 다시 확인해줘
다음 배포 30분 뒤에 한 번만 상태 확인해줘
매주 월요일 오전 9시에 PR 리뷰 상태 요약해줘
```

The LLM-facing `cron` tool intentionally exposes only one parameter: `command`. Agents should call `cron help` when they need the grammar, then pass a CLI-style command string. Scheduled prompts must be self-contained because headless runs do not have access to the original session history.

## Tool commands

```text
cron help
cron status
cron list [--include-prompt]
cron upsert [<id>] --name <name> --kind <cron|at|delay> (--schedule <expr>|--run-at <iso>) [--cwd <path>] [--enabled <true|false>] [--once] -- <promptMarkdown>
cron update <id> [--name <name>] [--kind <cron|at|delay>] [--schedule <expr>] [--run-at <iso>] [--cwd <path>] [--enabled <true|false>] [--once|--once=false] [-- <promptMarkdown>]
cron run <id>
cron enable <id>
cron disable <id>
cron remove <id>       # deletes immediately
cron start-daemon      # alias: cron start
cron stop-daemon       # alias: cron stop
cron install-launchd   # alias: cron install
cron uninstall-launchd [--yes] # --yes skips extra UI confirm; alias: cron uninstall
```

Human-facing slash commands are still available for convenience:

```text
/cron status
/cron install       # install launchd LaunchAgent and start daemon
/cron uninstall     # confirm, then remove LaunchAgent (`/cron uninstall --yes` skips extra UI confirm)
/cron start         # start daemon for current boot
/cron stop          # stop daemon
/cron list
/cron run <id>
/cron remove <id>   # deletes immediately
/cron enable <id>
/cron disable <id>
```

## One-shot jobs

`kind: "at"` and `kind: "delay"` are always one-shot. A `kind: "cron"` job can also be one-shot with `once: true`.

After a one-shot job runs, it is not deleted. It is updated with:

```json
{
  "enabled": false,
  "disabledReason": "completed_once",
  "completedAt": "..."
}
```

This keeps the job visible for later audit while preventing future execution.

## Safety

- Removing a job deletes it immediately without a confirmation dialog, including in non-UI contexts.
- Uninstalling launchd requires `ctx.ui.confirm()` unless explicitly confirmed with `--yes`.
- In non-UI contexts, launchd uninstall is denied unless `--yes` is provided.
- Job IDs are restricted to `[a-zA-Z0-9._-]`.
- Prompt files are written only under `~/.pi/agent/cron/prompts/`.

## Updating the package

After updating or changing the package installation source, inspect `~/Library/LaunchAgents/dev.pi.cron.plist`. Its `ProgramArguments` entry must resolve to the installed package's current `daemon.mjs`. If the path is stale, uninstall and reinstall the LaunchAgent from the currently loaded package.

## Moving from a local extension

The package reuses `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cron`, so existing jobs do not need data conversion. Use a coordinated cutover:

1. Back up `cron/jobs.json` and `cron/prompts/` under the Pi agent directory.
2. From the local extension, stop the daemon and uninstall its LaunchAgent.
3. Remove the local extension from Pi settings, then install this package. Never enable both copies together.
4. Restart Pi and run `cron status` to confirm the existing jobs are visible.
5. Run `cron install-launchd` from this package.
6. Confirm the plist points to this package's `daemon.mjs`, then verify `launchctl print gui/$(id -u)/dev.pi.cron`.
7. Run a harmless one-shot job and inspect its run log and disabled-history state.

Keep the LaunchAgent label `dev.pi.cron`; do not create a second service during migration. Do not delete the cron state directory.
