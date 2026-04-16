# claude-hooks-bridge

Bridge [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) (`.claude/settings.json`) into pi extension lifecycle events.

## What it does

- Reads `.claude/settings.json` hooks configuration from the project root
- Executes hooks at matching lifecycle events:
  - **SessionStart** → `session_start`
  - **UserPromptSubmit** → `before_agent_start`
  - **PreToolUse** → `tool_call` (can block / ask for confirmation)
  - **PostToolUse** → `tool_result`
  - **Stop** → `agent_end` (can queue follow-up messages)
- Supports matcher patterns (regex or pipe-separated tool names)
- Maps pi tool names to Claude Code equivalents (`bash` → `Bash`, etc.)
- Handles hook JSON output with `permissionDecision` / exit code 2 for blocking
- Provides transcript files for Stop hooks

## Requirements

- **bash** is required — hooks are executed via `bash -lc`. Works on macOS and Linux. Not natively supported on Windows.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-claude-hooks-bridge
```
