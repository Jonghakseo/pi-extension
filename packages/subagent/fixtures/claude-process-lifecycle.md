# Claude CLI Process Lifecycle Spec

Date: 2026-04-06
CLI version: `2.1.91 (Claude Code)`
Fixture source: `extensions/subagent/fixtures/claude-stream/*.ndjson`

This document defines the process lifecycle contract that `runClaudeAgent()` must implement. All assertions are grounded in observed fixture data unless marked `[OPEN]`.

---

## 1. Normal Termination

### 1.1 Final result event

Every successful `claude -p --output-format stream-json` run ends with a `type: "result"` event. This is the **single authoritative signal** that the Claude CLI process has finished its work.

Observed `result` event fields (present in all fixtures):

| Field | Type | Meaning |
|---|---|---|
| `type` | `"result"` | Always `"result"` |
| `subtype` | `"success"` | Observed in all fixtures, including the auth-error case |
| `is_error` | `boolean` | `false` for normal completion; `true` for auth failure (bare-auth-error) |
| `result` | `string` | Final text output from the assistant |
| `stop_reason` | `string` | `"end_turn"` for normal completion; `"stop_sequence"` for auth failure |
| `session_id` | `string` (UUID) | Same session_id seen throughout the stream |
| `duration_ms` | `number` | Wall-clock duration of the run |
| `duration_api_ms` | `number` | API call time |
| `num_turns` | `number` | Number of assistant turns completed |
| `total_cost_usd` | `number` | Total cost; `0` for auth failure |
| `usage` | `object` | Token counts |
| `permission_denials` | `array` | Tools denied by permission policy |
| `terminal_reason` | `string` | Observed value: `"completed"` in all fixtures |
| `fast_mode_state` | `string` | Observed: `"off"` |

### 1.2 Determining success vs. failure from `result` event

```
if result.is_error === true:
    ERROR (e.g. auth failure, see section 5)
else if result.permission_denials.length > 0:
    PARTIAL SUCCESS with denials (see section 5)
else if result.stop_reason === "end_turn":
    SUCCESS
else:
    [OPEN] other stop_reason values not yet observed
```

### 1.3 Exit code

The `result` event does NOT contain a process exit code. The exit code comes from the child process `exit`/`close` events at the OS level.

Observed behavior:
- Successful runs: the process exits normally after emitting `result`.
- Auth-failure (`bare-auth-error.ndjson`): the process emits `result` with `is_error: true` and then exits.

`[OPEN]` The exact exit code for each scenario has not been captured in fixtures. The runner must capture exit code from `proc.on("exit")` / `proc.on("close")` independently.

### 1.4 Event sequence for normal single-turn completion

Observed in `basic-text.ndjson`:

```
system/hook_started (x N)
system/hook_response (x N)
system/init
stream_event/message_start
stream_event/content_block_start (type: "text")
stream_event/content_block_delta (type: "text_delta")  [x N]
assistant (finalized message with full content)
stream_event/content_block_stop
stream_event/message_delta (stop_reason: "end_turn")
stream_event/message_stop
rate_limit_event
result (subtype: "success", is_error: false)
```

### 1.5 Event sequence for multi-turn tool-use completion

Observed in `tool-call.ndjson` and `long-running.ndjson`:

```
system/hook_started, system/hook_response, system/init
--- Turn 1: tool invocation ---
stream_event/message_start
stream_event/content_block_start (type: "tool_use")
stream_event/content_block_delta (type: "input_json_delta")  [x N]
assistant (finalized message with tool_use content)
stream_event/content_block_stop
stream_event/message_delta (stop_reason: "tool_use")
stream_event/message_stop
rate_limit_event
user (tool_result with stdout/stderr)
--- Turn 2: final text ---
stream_event/message_start
stream_event/content_block_start (type: "text")
stream_event/content_block_delta (type: "text_delta")  [x N]
assistant (finalized message with text content)
stream_event/content_block_stop
stream_event/message_delta (stop_reason: "end_turn")
stream_event/message_stop
result (subtype: "success")
```

Key observations:
- Between turns, a `user` event carries the `tool_result`.
- The `user` event includes `tool_use_result` with `stdout`, `stderr`, `interrupted`, `isImage`.
- During tool execution (e.g. `sleep` loop in `long-running.ndjson`), **no intermediate events are emitted**. The stream goes quiet until the tool completes.
- `long-running.ndjson` duration was 12450ms wall-clock, 7610ms API; the gap is tool execution time.

---

## 2. Final Result Event Criteria

### 2.1 Definitive signal

The `type: "result"` event is the **only** definitive signal that a Claude CLI print-mode run is complete. The runner MUST NOT treat `message_stop`, `message_delta` with `stop_reason: "end_turn"`, or the `assistant` snapshot event as final -- these occur per-turn, not per-run.

### 2.2 `assistant` snapshot events

The Claude stream emits `type: "assistant"` events that contain a finalized snapshot of the current assistant message. These appear after the streaming deltas for each turn. They are useful for extracting completed content but are NOT terminal signals since more turns may follow (tool use -> tool result -> next turn).

### 2.3 `session_id` availability

`session_id` is available from the very first event (observed: `system/hook_started`). It is stable throughout the run and repeated on every event. The runner can capture it as early as the first parsed line.

---

## 3. Stream Stall / Alive-but-silent Process

### 3.1 Observed silent gaps

In `long-running.ndjson`, the stream goes silent for ~5 seconds during `sleep 1` x4 Bash tool execution. No heartbeat or progress events are emitted during tool execution.

### 3.2 Recommended fallback policy

| Condition | Policy |
|---|---|
| No events received AND `result` not yet seen | Start an inactivity timer from last event timestamp |
| Inactivity timeout exceeded | Send SIGTERM to child process |
| SIGTERM grace period exceeded | Send SIGKILL |
| Process exited but `result` never seen | Treat as abnormal termination; report stderr |

Recommended timeouts (parity with pi runner):

| Timer | Value | Rationale |
|---|---|---|
| Inactivity timeout | `[OPEN]` | Pi runner uses `scheduleAgentEndForceResolve` at 1500ms, but Claude runs may have longer silent tool executions. Needs tuning. |
| SIGTERM->SIGKILL grace | 5000ms | Matches pi runner's `setTimeout(() => proc.kill("SIGKILL"), 5000)` |

`[OPEN]` The inactivity timeout value for Claude runner needs empirical tuning. Tool calls like `sleep 60` or `npm install` can create legitimate long gaps. Options:
1. Use a longer base timeout (e.g. 300s) for tool-execution phases.
2. Reset inactivity timer on every event, including `content_block_delta`.
3. Use the `result` event as the only clean-exit signal; use inactivity timeout only as a last-resort kill.

### 3.3 Post-`result` process linger

The pi runner has `scheduleAgentEndForceResolve()` to handle cases where the process stays alive after the logical end. The Claude runner needs an equivalent:
- After receiving `result`, if the process has not exited within 3000ms, send SIGTERM.
- After SIGTERM, if still alive after 5000ms, send SIGKILL.
- Resolve the promise immediately upon receiving `result`; do not wait for process exit.

---

## 4. Abort Signal Handling

### 4.1 Required contract (parity with pi runner)

```typescript
if (signal) {
    const killProc = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
            if (!procExited && proc.exitCode === null)
                proc.kill("SIGKILL");
        }, 5000);
    };
    if (signal.aborted) killProc();
    else signal.addEventListener("abort", killProc, { once: true });
}
```

This is a direct port of the pi runner abort logic at `runner.ts:406-417`.

### 4.2 Post-abort behavior

- Set `wasAborted = true` before killing.
- After process resolves, throw `new Error("Subagent was aborted")` (matches pi runner at line 421).
- Any partial `result` event received before abort should still be consumed for logging/diagnostics but not treated as success.

### 4.3 Child process cleanup

Claude CLI spawns as a single process. `[OPEN]` Whether `claude -p` spawns further child processes (e.g. for MCP servers, tool execution) that need separate cleanup is not yet observed. SIGTERM to the main process should propagate to the process group, but this is not verified.

---

## 5. Error Patterns

### 5.1 Permission denial (error.ndjson)

When running under `--permission-mode default` without `--allowedTools`, tool calls are denied:

- The tool call proceeds normally through `content_block_start`/`content_block_delta`/`assistant`.
- Instead of a normal `user` tool_result, the result has `is_error: true` with content `"This command requires approval"`.
- The assistant receives this error and may produce a follow-up text turn.
- The final `result` event has `is_error: false` (the run itself succeeded) but `permission_denials` is non-empty.

Denial entry structure:
```json
{
    "tool_name": "Bash",
    "tool_use_id": "toolu_013MDYgBHwAfBXqNuijDThbG",
    "tool_input": {"command": "printf denied-test", "description": "Print test string"}
}
```

Runner action: If `result.permission_denials.length > 0`, treat as a configuration error in the Claude runner (our `--allowedTools` was incomplete). Log and report as error.

### 5.2 Authentication failure (bare-auth-error.ndjson)

Observed when `--bare` is used without API key auth:

```
system/init (no hooks, tools limited)
assistant (synthetic message: "Not logged in - Please run /login", error: "authentication_failed")
result (is_error: true, result: "Not logged in - Please run /login", total_cost_usd: 0, duration_ms: 26)
```

Key differences from normal flow:
- No `hook_started`/`hook_response` events (bare mode skips hooks).
- The `assistant` event has an `error` field: `"authentication_failed"`.
- `result.is_error` is `true`.
- `result.stop_reason` is `"stop_sequence"` instead of `"end_turn"`.
- `duration_ms` is extremely short (26ms) since no API call was made.

Runner action: Detect `result.is_error === true` and report the error immediately.

### 5.3 stderr collection

The Claude CLI process writes to stderr independently of the JSON stream. The runner must:
1. Collect all stderr output via `proc.stderr.on("data")`.
2. Attach collected stderr to the result for diagnostics.
3. If no `result` event is received and process exits with non-zero code, stderr is the primary diagnostic source.

`[OPEN]` No fixture captures actual stderr output from Claude CLI. The pi runner appends diagnostic lines to `result.stderr` for internal tracking (e.g. "no assistant/tool messages captured"). The Claude runner should do the same.

### 5.4 Rate limit events

All fixtures show `rate_limit_event` events between turns:
```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":...,"rateLimitType":"five_hour",...}}
```

Runner action: Log for diagnostics. `[OPEN]` If `status` is not `"allowed"`, this may indicate throttling. No throttled fixture has been captured yet.

---

## 6. runPiAgent() Parity Checklist

This section maps every recovery/lifecycle mechanism in the current `runPiAgent()`/`runSingleAgent()` (runner.ts) to the equivalent requirement for `runClaudeAgent()`.

### 6.1 Process spawn and stdio

| Pi runner | Claude runner equivalent | Status |
|---|---|---|
| `spawn("pi", args, {cwd, shell: false, stdio: ["ignore", "pipe", "pipe"]})` | `spawn("claude", args, {cwd, shell: false, stdio: ["ignore", "pipe", "pipe"]})` | Direct port |
| stdout NDJSON line-by-line parsing | stdout NDJSON line-by-line parsing (same pattern) | Direct port |
| stderr accumulation into `currentResult.stderr` | Same | Direct port |

### 6.2 Event parsing state machine

| Pi runner event | Claude runner equivalent |
|---|---|
| `agent_start` / `turn_start` | `system/init` (session start); no direct equivalent for turn start -- use `stream_event/message_start` |
| `agent_end` (with `event.messages`) | `result` event (final, authoritative) |
| `message_update` with `text_delta` | `stream_event/content_block_delta` with `type: "text_delta"` |
| `tool_execution_start` | `stream_event/content_block_start` with `type: "tool_use"` |
| `message_end` with finalized message | `assistant` snapshot event (finalized message per turn) |
| `tool_result_end` | `user` event with `tool_result` content |

### 6.3 Abort handling

| Pi runner | Claude runner | Status |
|---|---|---|
| `signal.addEventListener("abort", killProc)` | Same | Direct port |
| SIGTERM then SIGKILL after 5000ms | Same | Direct port |
| `wasAborted` flag | Same | Direct port |
| Throw `"Subagent was aborted"` after resolution | Same | Direct port |
| Check `signal.aborted` before starting listener | Same | Direct port |

### 6.4 Fallback timers

| Pi runner mechanism | Claude runner equivalent | Notes |
|---|---|---|
| `scheduleAgentEndForceResolve()`: 1500ms after `agent_end` + no new events, force SIGTERM + resolve | Post-`result` linger timeout: after `result` received, if process alive after 3000ms, SIGTERM | Pi uses 1500ms; Claude should use a slightly longer window since `result` is more authoritative |
| `exitFallbackTimer`: 1500ms after `exit` event, force resolve | Same pattern: after `exit`, 1500ms then resolve | Direct port |
| `resolveOnce()` deduplication | Same: settled flag to prevent double-resolution | Direct port |
| `lastEventAt` tracking for stall detection | Same: track last event timestamp | Direct port |

### 6.5 Exit code and settle reason tracking

| Pi runner | Claude runner | Status |
|---|---|---|
| `settleReason` diagnostic string | Same | Direct port |
| `lastExitCode` from `proc.on("exit")` | Same | Direct port |
| `procExited` flag | Same | Direct port |
| Flush remaining `buffer` on resolve | Same | Direct port |

### 6.6 Unparsed stdout diagnostics

| Pi runner | Claude runner | Status |
|---|---|---|
| `unparsedStdoutCount` / `unparsedStdoutTail` tracking | Same -- count and store tail of non-JSON lines for diagnostics | Direct port |
| Diagnostic appended when `messages.length === 0` at resolve | Same | Direct port |

### 6.7 Result extraction

| Pi runner | Claude runner equivalent |
|---|---|
| `getFinalOutput(messages)` scans last assistant text | Extract `result.result` string directly from `result` event |
| `messages` array built from `message_end` events | `assistant` snapshot events collected per turn |
| `usage` accumulated per `message_end` | `result.usage` provides aggregate; per-turn from `message_delta.usage` |
| `stopReason` from `message_end` / `agent_end` | `result.stop_reason` |
| `model` from message | `assistant.message.model` or `system/init.model` |
| `errorMessage` from message | `assistant.error` field or `result.is_error` + `result.result` |

### 6.8 Live update / widget parity

| Pi runner | Claude runner | Status |
|---|---|---|
| `liveText` updated on `text_delta` | Same: accumulate from `content_block_delta` with `text_delta` | Direct port |
| `liveToolCalls` incremented on `tool_execution_start` | Increment on `content_block_start` with `type: "tool_use"` | Adapted |
| `emitUpdate()` calls `onUpdate` callback | Same | Direct port |
| `liveText` cleared on finalized assistant message | Clear on `assistant` snapshot for current turn | Adapted |
| `thoughtText` from thinking blocks | `[OPEN]` No thinking block observed in fixtures. Claude supports extended thinking; parse if `content_block_start` has `type: "thinking"`. |
| `liveActivityPreview` for hang detection | Build from last `liveToolCalls` state or last `text_delta` | Adapted |

### 6.9 Session file / temp file cleanup

| Pi runner | Claude runner | Status |
|---|---|---|
| `writePromptToTempFile()` for system prompt | Same: use `--append-system-prompt-file <path>` | Direct port |
| `finally` block: `unlinkSync` temp file + `rmdirSync` temp dir | Same | Direct port |

### 6.10 Items NOT in pi runner that Claude runner needs

| New requirement | Rationale |
|---|---|
| `session_id` capture from early events | Claude resume requires UUID; pi uses `--session` file path |
| `permission_denials` check from `result` | Pi uses `permissionMode: "dontAsk"` implicitly; Claude runner must validate `--allowedTools` coverage |
| `result.is_error` check | Pi does not have an equivalent top-level error flag in its event stream |
| `rate_limit_event` handling | `[OPEN]` Pi does not expose rate limit info; Claude runner should log and possibly retry |
| `--bare` auth failure detection | Pi does not use `--bare`; Claude runner must handle auth errors gracefully |

---

## 7. Open Items Summary

| ID | Item | Context |
|---|---|---|
| OPEN-1 | Inactivity timeout value for tool execution phases | Section 3.2 |
| OPEN-2 | Exact exit codes for each termination scenario | Section 1.3 |
| OPEN-3 | Whether SIGTERM propagates to Claude's child processes | Section 4.3 |
| OPEN-4 | `rate_limit_event` with `status !== "allowed"` behavior | Section 5.4 |
| OPEN-5 | Extended thinking (`type: "thinking"`) content_block handling | Section 6.8 |
| OPEN-6 | `--bare` auth workaround for runtime deployment | Section 5.2 |
| OPEN-7 | Rate limit retry policy | Section 6.10 |
