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
- New jobs default to `user` scope. `project` jobs are visible only from the same Git remote/root commit/path identity. `session` jobs are visible only from their original persisted Pi session.
- User and project jobs run through a headless Pi process: `pi -p --no-session @prompt.md`.
- Session jobs deliver to a live original session through a user-only local socket. If that session is fully closed, the daemon opens its original session file with `pi --mode rpc --session <file>`, verifies its identity, and waits for `agent_settled` or a confirmed idle state after an immediate command. It never creates a separate `--no-session` conversation for a session job.
- Extensions and MCP tools are loaded as in interactive mode so scheduled prompts can call MCP tools (Slack, Jira, etc.).
- Uses a detached daemon and macOS `launchd` LaunchAgent so jobs continue after Pi exits and after reboot/login.
- Moves one-shot jobs out of the current job list and into history after their first execution attempt.
- Deletes jobs immediately when `cron remove` or `/cron remove` is called. LaunchAgent uninstall still requires confirmation unless `cron uninstall-launchd --yes` is used.

## Files

```text
~/.pi/agent/cron/jobs.json
~/.pi/agent/cron/prompts/<jobId>.md
~/.pi/agent/cron/runs/<jobId>/<timestamp>.log
~/.pi/agent/cron/sessions/<session-hash>.json  # live session IPC owner lease
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

The LLM-facing `cron` tool intentionally exposes only one parameter: `command`. Agents should call `cron help` when they need the grammar, then pass a CLI-style command string. User and project prompts must be self-contained because headless runs do not have access to the original session history. Session jobs retain that original session history.

## Tool commands

```text
cron help
cron status [--scope <user|project|session>]
cron list [--scope <user|project|session>] [--include-prompt]       # current jobs only
cron history [--scope <user|project|session>] [--include-prompt]    # completed one-shot jobs
cron upsert [<id>] --name <name> --kind <cron|at|delay> (--schedule <expr>|--run-at <iso>) [--scope <user|project|session>] [--cwd <path>] [--enabled <true|false>] [--once] -- <promptMarkdown>
cron update <id> [--scope <user|project|session>] [--name <name>] [--kind <cron|at|delay>] [--schedule <expr>] [--run-at <iso>] [--cwd <path>] [--enabled <true|false>] [--once|--once=false] [-- <promptMarkdown>]
cron run <id> [--scope <user|project|session>]
cron enable <id> [--scope <user|project|session>]
cron disable <id> [--scope <user|project|session>]
cron remove <id> [--scope <user|project|session>]       # deletes immediately
cron start-daemon      # alias: cron start
cron stop-daemon       # alias: cron stop
cron update-runtime    # drain and replace an outdated running daemon without reinstalling launchd
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
/cron update-runtime # safely drain and replace an outdated running daemon
/cron list          # current jobs only
/cron history       # completed one-shot jobs
/cron run <id>
/cron remove <id>   # deletes immediately
/cron enable <id>
/cron disable <id>
```

## Scopes

`user` is the explicit default and remains compatible with legacy jobs that have no scope field. Accessible results always combine user jobs with the current project and current session, then an optional `--scope` narrows that result.

A job cannot be moved between scopes with `update`; create a new job in the destination scope. This prevents a guessed job ID from retargeting another project or session. Session scope requires a persisted current session ID and file.

For a one-shot session job, history records delivery acceptance or queueing, not the eventual task result. The task output remains in its original conversation.

## One-shot jobs

`kind: "at"` and `kind: "delay"` are always one-shot. A `kind: "cron"` job can also be one-shot with `once: true`.

After the first execution attempt, a one-shot job is atomically removed from the current `jobs` array and appended to the `history` array in `jobs.json`. The archived entry keeps its full metadata, prompt file, exit code, completion timestamp, and run log path. Waiting for a session owner to become ready or finish a handoff does not consume that attempt.

`cron list` and `/cron list` show current jobs only. Use `cron history [--include-prompt]` or `/cron history` to inspect completed one-shot jobs. Existing version 1 stores are migrated in memory, so previously completed one-shot jobs appear in history after upgrading.

## Safety

- Removing a job deletes it immediately without a confirmation dialog, including in non-UI contexts.
- Uninstalling launchd requires `ctx.ui.confirm()` unless explicitly confirmed with `--yes`.
- In non-UI contexts, launchd uninstall is denied unless `--yes` is provided.
- Job IDs are restricted to `[a-zA-Z0-9._-]`.
- Prompt files are written only under `~/.pi/agent/cron/prompts/`.
- Archived job IDs remain reserved so a future job cannot overwrite a preserved history prompt.
- Session ownership protects cooperating runtimes that load this extension and use the same Pi agent directory. It is not a global lock on the transcript file. Do not concurrently open the same session in an older runtime or one without this extension.
- A live session must load the updated extension before it can accept scheduled messages through the local bridge. Its lease moves through `starting`, `active`, and `draining`; the daemon defers, rather than fails, jobs while it is not ready or is handing off.
- On `session_shutdown`, the lease remains `draining` until Pi emits the documented successor `session_start` event or the owner process is provably gone. A host that disposes a session without either signal fails closed, so its due session jobs remain deferred rather than being resumed concurrently. The host must complete a documented session replacement or exit its process before cron can resume that session.
- Lease and transaction-lock cleanup check the process start identity as well as PID (`/proc` boot ID plus start time on Linux, `/bin/ps -o lstart` on macOS). If the PID is live but its recorded start identity cannot be checked, ownership is not stolen.
- A connection lost after sending a prompt may hide an accepted delivery. Cron records a failed delivery instead of automatically resending it. Check the original session before retrying manually.

The handoff uses Pi's [documented session lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#session_shutdown). Closed-session delivery follows the [RPC contract](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).

## Updating the package

`cron update-runtime` is the explicit safe cutover command used after a normal in-place package update. It waits for an outdated running daemon to stop claiming work, drains its active job, and verifies that the replacement owns the requested runtime before reporting success. A loaded matching LaunchAgent is kickstarted only after the old daemon exits. A manually started daemon is replaced manually. A daemon that was already stopped remains stopped, including when its matching LaunchAgent plist is present but unloaded.

The update path never calls `cron install-launchd`, `launchctl bootout`, `bootstrap`, or `kickstart -k`. Those are setup operations and can interrupt active work. `cron update-runtime` has a bounded coordinator deadline. If it times out or cannot prove the replacement owner, it reports failure instead of claiming a successful update.

A LaunchAgent that points to another package path, Pi binary, or `PI_CODING_AGENT_DIR` is a migration, not an in-place update. Cron blocks that state without touching the running daemon. Schedule a maintenance window, confirm active work has drained, then explicitly uninstall and reinstall the LaunchAgent from the updated package. Do not run that setup sequence while a job is active.

[`pi update --extensions`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#install-and-manage) updates unpinned package specs but does not reload already-open Pi sessions. Restart Pi or run `/reload` in an open session to load the updated extension and then run `cron update-runtime`. Pinned package specs are not changed by that command.

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
