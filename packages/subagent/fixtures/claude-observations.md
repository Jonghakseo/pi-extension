# Claude CLI observations for T00c

Date: 2026-04-06
CLI version observed: `2.1.91 (Claude Code)`
Working repo for observations: `/Users/example/.pi/agent`

This document records **observed facts** from local `claude` CLI experiments for runtime planning. Interpretations are separated from raw observations.

## Environment notes

- Non-bare runs in this environment expose `permissionMode: "dontAsk"` in the `stream-json` `init` event.
- Ambient MCP servers were present in the user config before these tests (`example-company`, `context7`, `dba-mcp`, plus auth-needed servers).
- Personal auth/org identifiers from `claude auth status --text` are intentionally omitted here.

## Quick findings checklist

- `--resume` accepts a UUID `session_id`, and that UUID is observable in `stream-json` before assistant output.
- In the observed `stream-json --verbose` runs, `hook_started` / `hook_response` events appeared **before** `system/init`, and those pre-init hook events already carried the same `session_id` later seen in `init`.
- `stream-json` observation in this environment required `--verbose`; without it, the early lifecycle metadata needed for policy decisions was not part of the captured evidence here.
- `--bare` is currently a blocker in this environment because it does not use the existing OAuth/keychain-backed login and immediately fails with `Not logged in · Please run /login`.
- `--mcp-config` alone does not isolate MCP sources; `--strict-mcp-config` was additionally required to suppress ambient MCP discovery, but that observation only covered MCP/tool exposure and did **not** prove full runtime isolation from hooks/plugins/skills/slash-command surface.
- Same-cwd `--resume` succeeded, preserved the same UUID, and recalled a prior-turn nonce; cross-cwd `--resume` did not find the conversation.

---

## 1) `--resume` session handle format

### Observed

A normal `--print` JSON result includes a UUID session id:

```bash
claude -p "say ok" --output-format json
```

Observed result excerpt:

```json
{
  "session_id": "f110cdeb-3b75-4dd8-a8f8-f09d762ef971"
}
```

The persisted conversation file for a print-mode run was found under a project-scoped path using the same UUID filename:

```text
~/.claude/projects/<cwd-encoded>/5ec0baa5-d456-4093-ac1b-9c338db55bcb.jsonl
```

### Interpretation

- The resume handle accepted by `--resume` is a **UUID session id**, not the `ses_*` transcript filename format seen elsewhere under `~/.claude/transcripts/`.
- Session persistence for print-mode runs is project-scoped on disk.

---

## 2) When the session handle first becomes observable

### Observed

With `stream-json + --verbose`, the session id appears in system events before assistant output. In the observed run, pre-init hook events arrived first and already included the same session id later repeated by `init`:

```bash
claude -p "say ok" --output-format stream-json --verbose \
  --mcp-config extensions/subagent/fixtures/claude-mcp-context7-only.json \
  --strict-mcp-config
```

Observed event order excerpt:

```json
{"type":"system","subtype":"hook_started","session_id":"68939193-baac-4486-a810-8c5c3d5c4ed5"}
{"type":"system","subtype":"hook_started","session_id":"68939193-baac-4486-a810-8c5c3d5c4ed5"}
{"type":"system","subtype":"hook_response","session_id":"68939193-baac-4486-a810-8c5c3d5c4ed5"}
{"type":"system","subtype":"hook_response","session_id":"68939193-baac-4486-a810-8c5c3d5c4ed5"}
{"type":"system","subtype":"init","cwd":"/Users/example/.pi/agent","session_id":"68939193-baac-4486-a810-8c5c3d5c4ed5"}
```

In plain `--output-format json`, the session id was only visible in the final result object.

### Interpretation

- If the runner needs the Claude session handle as early as possible, `stream-json` parsing can capture it from early system events; in the observed run, the same `session_id` was already present on pre-init hook events and then on `system/init`.
- `system/init` should therefore not be treated as proof that no prior startup surface executed; hook activity may already have occurred before `init` is seen.
- In these observations, capturing that early lifecycle metadata required `--verbose` on the `stream-json` command path.
- If using plain JSON/text output only, the session id is effectively available at completion time.

---

## 3) What `--bare` actually changes

### Observed

Non-bare sanity check succeeded:

```bash
claude -p "say ok" --output-format text
```

Observed output:

```text
ok
```

Bare mode failed immediately in the same environment:

```bash
claude --bare -p "say ok" --output-format text
```

Observed output:

```text
Not logged in · Please run /login
```

Observed `--help` text also states that bare mode skips hooks/LSP/plugin sync/CLAUDE.md auto-discovery and does not read OAuth/keychain auth.

### Interpretation

- In this local environment, `--bare` is not usable with the existing login method; it conflicts with the current OAuth/keychain-backed login flow and instead expects API-key-style auth.
- Operationally, `--bare` is therefore a current blocker for the default local auth setup used in these tests.
- Using `--bare` would also remove ambient startup behavior (hooks, plugins, CLAUDE.md auto-discovery, etc.), so it is a materially different runtime, not just a lighter UI mode.

---

## 4) `--tools` + `--allowedTools` and permission prompts/denials

### Observed

#### 4-a. Bash

```bash
tmpdir=$(mktemp -d)
cd "$tmpdir"
claude -p "Use Bash to run 'pwd' once and output only the command result." \
  --output-format json --tools Bash
```

Observed result excerpt:

```json
{
  "result": "`/var/.../tmp.VmjjsglvNt`",
  "permission_denials": []
}
```

#### 4-b. Edit without allowlist

```bash
tmpdir=$(mktemp -d)
cd "$tmpdir"
printf 'hello\n' > sample.txt
claude -p "Use Read to inspect sample.txt, then use Edit to change hello to world, then reply DONE only." \
  --output-format json --tools Read Edit
```

Observed result excerpt:

```json
{
  "permission_denials": [
    {
      "tool_name": "Edit"
    }
  ]
}
```

The assistant text reported that Edit permission was denied.

#### 4-c. Edit with allowlist

```bash
tmpdir=$(mktemp -d)
cd "$tmpdir"
printf 'hello\n' > sample.txt
claude -p "Use Read to inspect sample.txt, then use Edit to change hello to world, then reply DONE only." \
  --output-format json --tools Read Edit --allowedTools Edit
```

Observed result excerpt:

```json
{
  "result": "DONE",
  "permission_denials": []
}
```

#### 4-d. Write without allowlist

```bash
tmpdir=$(mktemp -d)
cd "$tmpdir"
claude -p "Use Write to create note.txt containing exactly 'hello-write', then reply DONE only." \
  --output-format json --tools Write
```

Observed result excerpt:

```json
{
  "permission_denials": [
    {
      "tool_name": "Write"
    }
  ]
}
```

#### 4-e. Write with allowlist

```bash
tmpdir=$(mktemp -d)
cd "$tmpdir"
claude -p "Use Write to create note.txt containing exactly 'hello-write', then reply DONE only." \
  --output-format json --tools Write --allowedTools Write
```

Observed result excerpt:

```json
{
  "result": "DONE",
  "permission_denials": []
}
```

### Interpretation

- In this non-interactive `--print` flow, denied tool access surfaced as a **completed result containing `permission_denials`**, not as an interactive terminal prompt.
- `--tools` alone exposes a tool to the model, but that was **not sufficient** for `Edit`/`Write` in this environment.
- Adding `--allowedTools` removed the denial for `Edit` and `Write`.
- `Bash` succeeded without an extra allowlist in the tested case, so permission behavior is tool-specific and/or influenced by the environment's existing permission mode/settings.

---

## 5) `--mcp-config` and limiting MCP sources

Fixture used for reproducible tests:

- `extensions/subagent/fixtures/claude-mcp-context7-only.json`

### Observed

#### 5-a. `--mcp-config` without `--strict-mcp-config`

```bash
claude -p "say ok" --output-format stream-json --verbose \
  --mcp-config extensions/subagent/fixtures/claude-mcp-context7-only.json
```

Observed `init` event excerpt showed ambient servers were still present:

```json
{
  "mcp_servers": [
    { "name": "example-company", "status": "connected" },
    { "name": "context7", "status": "connected" },
    { "name": "dba-mcp", "status": "connected" },
    { "name": "Sentry", "status": "needs-auth" },
    { "name": "claude.ai Google Calendar", "status": "needs-auth" },
    { "name": "claude.ai Gmail", "status": "needs-auth" }
  ]
}
```

#### 5-b. `--mcp-config` with `--strict-mcp-config`

```bash
claude -p "say ok" --output-format stream-json --verbose \
  --mcp-config extensions/subagent/fixtures/claude-mcp-context7-only.json \
  --strict-mcp-config
```

Observed `init` event excerpt showed only the configured MCP server/toolset:

```json
{
  "tools": [
    "...",
    "mcp__context7__query-docs",
    "mcp__context7__resolve-library-id"
  ],
  "mcp_servers": [
    { "name": "context7", "status": "connected" }
  ]
}
```

### Interpretation

- `--mcp-config` alone **merges** with ambient MCP discovery/config.
- `--mcp-config` + `--strict-mcp-config` is the observed combination that limits the session to only the explicitly provided MCP source(s) in the `init.mcp_servers` / MCP tool list.
- However, this observation did **not** demonstrate full runtime isolation: pre-init hook events still executed before `init`, so downstream planning must not equate `--strict-mcp-config` with a clean slate for hooks, plugins, skills, or slash-command surface.

---

## 6) Resume behavior vs `cwd` / workspace

### Observed

#### 6-a. Resume from the same working directory

First run:

```bash
cd "$dirA"
claude -p "Remember this exact nonce for the next resumed turn: NONCE-20260406-ALPHA. Reply only SAVED:NONCE-20260406-ALPHA" --output-format json
```

Observed result excerpt:

```json
{
  "session_id": "16430b55-a029-4858-b957-b03af5390e17",
  "result": "SAVED:NONCE-20260406-ALPHA"
}
```

Resume in the same directory:

```bash
cd "$dirA"
claude -p --resume "$SESSION_ID" "What nonce did I ask you to remember in the previous turn? Reply only RECALL:<nonce>" --output-format json
```

Observed result excerpt:

```json
{
  "session_id": "16430b55-a029-4858-b957-b03af5390e17",
  "result": "RECALL:NONCE-20260406-ALPHA"
}
```

Observed result: the resumed run succeeded, the `session_id` remained the same UUID, and the prior-turn nonce was recalled correctly.

#### 6-b. Resume from a different working directory

A session created in `dirA` was resumed from `dirB` using the exact UUID reported by the first run:

```bash
cd "$dirB"
claude -p --resume "$SESSION_ID" "..." --output-format json
```

Observed error:

```text
No conversation found with session ID: 5ec0baa5-d456-4093-ac1b-9c338db55bcb
```

#### 6-c. Same-directory resume still sees same workspace files

In the same-directory resume case, a resumed command using Bash observed the same directory and found a file created in that directory:

```text
/var/.../tmp.f1IsSEvKX7
EXISTS
```

### Interpretation

- In this environment, `--resume <uuid>` lookup is **project/cwd scoped**; the same UUID was not found from a different directory.
- Resuming from the original directory preserved access to that directory's workspace/files.
- The same-cwd nonce recall result is evidence of conversation-state continuity across turns, not just session-id reuse.
- Cross-directory resume support was **not** observed.

---

## Planning implications (derived from observations above)

1. Capture `session_id` from early `stream-json` system events, not only from the final result; `system/init` is usable, but observed pre-init hook events also carried the same id.
2. Treat `--verbose` as required on the observation / parser-validation path used to inspect early lifecycle metadata in this environment.
3. Do **not** assume `--bare` is safe for v1; in this environment it breaks auth immediately because the current OAuth/keychain login is not honored there.
4. For non-interactive Claude runs that need file mutation, pass both:
   - a constrained `--tools` set, and
   - matching `--allowedTools` entries.
5. If the runtime must avoid ambient MCP bleed-through, use:
   - `--mcp-config <file>` **plus** `--strict-mcp-config`.
6. Do **not** overinterpret `--strict-mcp-config` as full runtime isolation; the observed guarantee here is limited to MCP server/tool exposure, while hooks had already fired before `init`.
7. Resume logic should treat Claude session ids as **workspace-scoped metadata**; restoring from a different cwd cannot be assumed to work, while same-cwd resume can preserve actual conversation state.

## Known gaps / blockers

- These observations were made under one local Claude Code setup with existing user config, plugins, hooks, and `permissionMode: "dontAsk"`; behavior may differ in other environments.
- Hook/plugin/skills/slash-command isolation was not exhaustively enumerated here; the only strong claim supported by evidence is that `--strict-mcp-config` constrained MCP exposure while pre-init hooks still fired.
- I did not observe a successful cross-workspace resume path.
- I did not test API-key-auth bare mode; only the existing OAuth/keychain-backed local login was observed.
