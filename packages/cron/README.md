# cron extension

![cron: Runs scheduled Pi jobs from a detached daemon that survives restarts.](./cover.svg)

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
- Session jobs deliver to a live original session through a user-only local socket. If that session is fully closed, the daemon opens its original session file with `pi --mode rpc --session <file>`, verifies its identity, and waits for `agent_settled` or a confirmed idle state after an immediate command. It never creates a separate `--no-session` conversation for a session job. The recorded `lastDeliveryOutcome` is `aborted` instead of `settled` when Pi `1.1.0` or later reports that the resumed run was cancelled.
- Extensions and MCP tools are loaded as in interactive mode so scheduled prompts can call MCP tools (Slack, Jira, etc.).
- Uses a detached daemon and macOS `launchd` LaunchAgent so jobs continue after Pi exits and after reboot/login.
- Moves one-shot jobs out of the current job list and into history after their first execution attempt.
- Removes active job records immediately when `cron remove` or `/cron remove` is called. Their prompt files and existing run logs remain available. LaunchAgent uninstall still requires confirmation unless `cron uninstall-launchd --yes` is used.

## Files

```text
~/.pi/agent/cron/jobs.json
~/.pi/agent/cron/prompts/<jobId>.md
~/.pi/agent/cron/runs/<jobId>/<timestamp>.log
~/.pi/agent/cron/sessions/<session-hash>.json  # live session IPC owner lease
~/.pi/agent/cron/daemon.pid
~/.pi/agent/cron/daemon.log
~/.pi/agent/cron/daemon.err.log
~/.pi/agent/cron/daemon-upgrade-coordinator.log
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
cron upsert [<id>] --name <name> --kind <cron|at|delay> (--schedule <expr>|--run-at <iso>) [--scope <user|project|session>] [--cwd <path>] [--enabled <true|false>] [--once] [--guard <cmd>] [--guard-mode <exit|changed>] [--guard-timeout <ms>] -- <promptMarkdown>
cron update <id> [--scope <user|project|session>] [--name <name>] [--kind <cron|at|delay>] [--schedule <expr>] [--run-at <iso>] [--cwd <path>] [--enabled <true|false>] [--once|--once=false] [--guard <cmd>|--guard ""] [--guard-mode <exit|changed>] [--guard-timeout <ms>] [-- <promptMarkdown>]
cron run <id> [--scope <user|project|session>]
cron enable <id> [--scope <user|project|session>]
cron disable <id> [--scope <user|project|session>]
cron remove <id> [--scope <user|project|session>]       # removes the active record; keeps prompt and run logs
cron start-daemon      # alias: cron start
cron stop-daemon       # alias: cron stop
cron update-runtime    # drain and replace an outdated running daemon without reinstalling launchd
cron install-launchd   # alias: cron install
cron uninstall-launchd [--yes] # --yes skips extra UI confirm; alias: cron uninstall
```

Cron schedules use five numeric fields: `minute hour day-of-month month day-of-week`. Each field accepts `*`, a single value, a range such as `1-5`, a list such as `1,3,5`, or a step such as `*/15` and `1-10/2`. Named months, named weekdays, macros, and a sixth seconds field are not supported. Schedules use the daemon's local timezone. Day of month and day of week must both match; Sunday is `0`.

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
/cron remove <id>   # removes the active record; keeps prompt and run logs
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

## Guards

A guard is a shell command the daemon runs before each execution. It decides whether Pi is called at all, so a job can poll every 10 minutes and still spend a model call only when something happened.

```text
cron upsert --name pr-cleanup-watch --kind cron --schedule "*/10 * * * *" --scope session --guard 'python3 ~/bin/check-prs.py "Product PR" --cleanup-only' --guard-mode changed -- <prompt>
```

The daemon runs `/bin/sh -c <guard>` in the job `cwd` with the same environment as a headless run. The guard has its own process group, so a timeout stops the commands it started too. `--guard-timeout` defaults to 60000 ms and is capped at 120000 ms (the CLI rejects larger values, the daemon clamps stored ones). After the timeout the daemon sends SIGTERM, then SIGKILL, and stops waiting on the output pipes, so a descendant that left the process group cannot hold the job.

| Mode | Runs when | Skips when | Guard error |
| --- | --- | --- | --- |
| `exit` (default) | exit 0 | exit 1 | exit 2 or higher, timeout, spawn failure |
| `changed` | exit 0, non-empty trimmed stdout, and its SHA-256 differs from `lastGuardHash` | exit 1, empty stdout, same output as the last successful run | same as `exit` |

When the job runs, trimmed guard stdout is appended to that run's prompt copy as a `## Guard output` section (first 16 KB, with a truncation note past that). The daemon captures at most 1 MiB of guard stdout; in `changed` mode the hash covers only what was captured. A one-line note under the heading says the block is data printed by the guard, to be treated as input and not as instructions. Headless runs and session deliveries read the same copy. The job's own prompt file is never changed. An empty stdout in `exit` mode adds no section.

In `changed` mode, `lastGuardHash` advances only after the run succeeds: a headless exit 0, or a session delivery the session accepted (`queued`, `settled`, or `aborted`). A failed run is retried on the next schedule slot with the same output. An empty output clears the hash, so the same list showing up again later is reported again.

A skip, including a guard error, does not start Pi, does not deliver to a session, and does not write a run log. It atomically releases the claim, deletes the claimed prompt copy, moves `nextRunAt` to the next schedule slot, and records `lastGuardAt`, `lastGuardExit` (a number or `"timeout"`), and `lastGuardError`. `lastRunAt`, `lastRunLog`, `lastExitCode`, and `lastDeliveryOutcome` keep describing the last real run. `daemon.log` gets one `job guard skip` line. Guard errors never disable the job. Consecutive errors are counted in `guardErrorStreak`, with the streak start in `guardErrorSince`; any guard result that is not an error clears both. Check `cron list` for `lastGuard`.

One-shot jobs are not consumed by a skip; they stay in the current job list. A due `at` or `delay` job would otherwise be re-checked on every 30-second tick, so after a skip its `nextRunAt` moves at least 60 seconds ahead while `runAt` stays unchanged. A `once` cron job waits for its next schedule slot. When a session delivery is deferred because the session owner is starting or handing off, the guard result is reused for up to two minutes instead of running the guard again on each retry.

`cron update <id> --guard ""` removes the guard and its recorded state. A guard command that starts with `--` must be written as `--guard=<cmd>`. Changing the guard command or mode also clears the recorded state. `cron run <id>` still goes through the guard.

### Older daemons

A daemon from before guards ignores the `guard` field and would call the model on every tick. The daemon now advertises `capabilities: ["guard"]` in `cron/daemon.runtime.json`, and `cron status` shows `Guard support`. Cron refuses to create, update, enable, or run an enabled guarded job while the running daemon does not advertise guard support, and asks you to run `cron update-runtime` first. Disabled guarded jobs can still be edited.

When the daemon is stopped, the command is allowed with a warning. The daemon that `upsert` starts, or that launchd restarts, loads this package's runtime from the same install path, so it supports guards. If your LaunchAgent points to a different, older install, migrate it as described in [Updating the package](#updating-the-package).

A daemon with guard support runs jobs without a `guard` field exactly as before.

Guards are arbitrary shell commands that the daemon runs as your user, unattended, on every due slot. Treat a guard like a crontab entry: anyone who can write `jobs.json` or call the `cron` tool can make the daemon run commands.

## Session start banner

User and project jobs run headlessly, so no session sees their failures, and a guard skip never produces a run at all. When an interactive Pi session starts, cron shows one warning banner for accessible jobs that need attention:

- an enabled guard job whose guard failed 3 or more times in a row, with how long it has been failing, the exit code, and the error
- enabled guard jobs while the running daemon does not support guards
- a current job whose last headless run exited non-zero, or whose last session delivery failed (skipped for jobs you disabled yourself)
- a one-shot job archived in the last 24 hours after a failed run

Each item stays in the banner until the job recovers, so it can repeat on every new session. That is intentional: a broken job should be hard to miss. The banner is skipped on `/reload`, in sessions without a UI (such as `pi -p`), and in sessions the daemon resumes over RPC.

## Safety

- Removing a job removes its active `jobs.json` record immediately without a confirmation dialog, including in non-UI contexts. Its prompt file and existing run logs are retained.
- Uninstalling launchd requires `ctx.ui.confirm()` unless explicitly confirmed with `--yes`.
- In non-UI contexts, launchd uninstall is denied unless `--yes` is provided.
- Job IDs are restricted to `[a-zA-Z0-9._-]`.
- Prompt files are written only under `~/.pi/agent/cron/prompts/`.
- Archived job IDs remain reserved so a future job cannot overwrite a preserved history prompt.
- Session ownership protects cooperating runtimes that load this extension and use the same Pi agent directory. It is not a global lock on the transcript file. Do not concurrently open the same session in an older runtime or one without this extension.
- A live session must load the updated extension before it can accept scheduled messages through the local bridge. Its lease moves through `starting`, `active`, and `draining`; the daemon defers, rather than fails, jobs while it is not ready or is handing off. When a compatible host pauses external delivery, such as during voice input or PTT, due session jobs also remain pending for a later attempt.
- On `session_shutdown`, the lease remains `draining` until Pi emits the documented successor `session_start` event or the owner process is provably gone. A host that disposes a session without either signal fails closed, so its due session jobs remain deferred rather than being resumed concurrently. The host must complete a documented session replacement or exit its process before cron can resume that session.
- Lease and transaction-lock cleanup check the process start identity as well as PID (`/proc` boot ID plus start time on Linux, `/bin/ps -o lstart` on macOS). If the PID is live but its recorded start identity cannot be checked, ownership is not stolen.
- A host that stops a session's process while the session stays open to its user (Picky puts idle Pickles to sleep this way) can keep the lease with `session-delegate.mjs` instead of letting the daemon resume the session over RPC behind the host's back. See [Session delegate for hosts](#session-delegate-for-hosts).
- A connection lost after sending a prompt may hide an accepted delivery. Cron records a failed delivery instead of automatically resending it. Check the original session before retrying manually.

### Session delegate for hosts

A host process that embeds Pi asks the extension, on the Pi event bus, whether it may hold the session: it emits `cron.session-delegate.query` and the extension answers synchronously on `cron.session-delegate.info` with `{ version: 1, available: true, modulePath, agentDir, sessionId, sessionFile }` while its bridge owns the session, or `{ version: 1, available: false }`. After the session's process has exited, the host imports `modulePath` (plain ESM, no Pi dependency) and calls:

- `claimDelegatedSessionOwner({ agentDir, sessionId, sessionFile, onDeferred })`: takes the lease only from a missing or provably dead owner (`SessionDelegateBusyError` otherwise). Every delivery is answered `deferred`, so the daemon retries on its next tick, and `onDeferred` tells the host to start the session's process. The delegate never sees the prompt and never reports `queued`.
- `reserveForSuccessor()`: before the host starts that process. The lease becomes a `reserved` record of the host, which the daemon defers on, and the returned string goes into the new process's `PI_CRON_SESSION_RESERVATION`. The extension adopts it as it adopts a cron RPC reservation, and the daemon then delivers live (`queued`).
- `releaseReservation()`: when the successor exited or never adopted. It removes only a reservation that is still the host's.
- `stop()`: when the host quits. The daemon falls back to RPC resume, as it does for a dead owner after a host crash.

An older extension never answers the query, so the host keeps its old behavior.

The handoff uses Pi's [documented session lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#session_shutdown). Closed-session delivery follows the [RPC contract](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).

## Updating the package

`cron update-runtime` is the explicit safe cutover command used after a normal in-place package update. It waits for an outdated running daemon to stop claiming work, drains its active job, and verifies that the replacement owns the requested runtime before reporting success. A loaded matching LaunchAgent is kickstarted only after the old daemon exits. A manually started daemon is replaced manually. A daemon that was already stopped remains stopped, including when its matching LaunchAgent plist is present but unloaded.

The update path never calls `cron install-launchd`, `launchctl bootout`, `bootstrap`, or `kickstart -k`. Those are setup operations and can interrupt active work. `cron update-runtime` has a bounded coordinator deadline. If it times out or cannot prove the replacement owner, it reports failure instead of claiming a successful update.

A LaunchAgent that points to another package path, Pi binary, or `PI_CODING_AGENT_DIR` is a migration, not an in-place update. Cron blocks that state without touching the running daemon. Schedule a maintenance window, confirm active work has drained, then explicitly uninstall and reinstall the LaunchAgent from the updated package. Do not run that setup sequence while a job is active.

[`pi update --extensions`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#install-and-manage) updates unpinned package specs but does not reload already-open Pi sessions. Restart Pi or run `/reload` in an open session to load the updated extension. On `session_start`, cron automatically schedules a nonblocking safe upgrade check for an outdated daemon. Run `cron update-runtime` when you need to wait for the cutover and confirm its result. Pinned package specs are not changed by `pi update --extensions`.

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
