# Claude stream-json fixtures

These files were captured from real Claude CLI runs on this machine.

## Captured files
Current directory contents:
- `README.md`
- `basic-text.ndjson`
- `tool-call.ndjson`
- `long-running.ndjson`
- `error.ndjson`
- `bare-auth-error.ndjson`

## Fixture scenarios
- `basic-text.ndjson` — plain text response only; no tool use.
- `tool-call.ndjson` — allowed `Bash` tool call, tool result, and final assistant text.
- `long-running.ndjson` — longer `Bash` execution (`sleep` loop) to observe multi-event timing around tool invocation, delayed completion, a single final `tool_result`, and the follow-up assistant response. This capture does **not** show incremental tool stdout streamed as separate intermediate tool-result events.
- `error.ndjson` — permission-related case where `Bash` was requested under `--permission-mode default` without an allowlist; the stream includes denial behavior and final `permission_denials` data.
- `bare-auth-error.ndjson` — separate `--bare` failure capture from this environment; `--bare` did not inherit the existing local login and returned `authentication_failed` / `Not logged in · Please run /login`.

## Observed capture commands
Successful `stream-json` captures on this machine required `--verbose` in addition to `-p --output-format stream-json --include-partial-messages`.

Because `--bare` was blocked by auth in this environment, the successful schema fixtures were collected with non-bare commands, while the bare-specific auth failure was preserved separately in `bare-auth-error.ndjson`.

## Scope and interpretation rule
Treat the raw `.ndjson` files in this directory as the parser source of truth for this machine/CLI version, not prior reference implementations.

This fixture set is a source of truth for the scenarios it actually contains: plain text, successful tool call flow, delayed tool completion flow, permission denial flow, and bare-mode auth failure.

This fixture set is **not** currently a source of truth for abort semantics, non-zero-exit tool handling, fallback behavior, or other lifecycle outcomes that are not represented by the captured files above. Downstream work for T00d/T05 must use separate evidence for those cases unless new fixtures are added.
