# subagent

Asynchronous subagent delegation for [pi](https://github.com/badlogic/pi-mono). Run specialist agents in isolated sessions or with selected main-session context, then receive completion results as follow-up messages.

## Requirements

- pi (tested with pi 0.80.6+)
- The default `claudeRuntime: "sdk"` uses the bundled `@anthropic-ai/claude-agent-sdk`; it does not require the Claude Code CLI. Configure supported Anthropic authentication, such as `ANTHROPIC_API_KEY`, as described in the [official Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/overview).
- `claudeRuntime: "cli"` requires the `claude` executable on `PATH` and an authenticated Claude Code installation.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-subagent
```

## Agent definitions

Agents are discovered from these locations, with project definitions taking precedence:

- `$PI_CODING_AGENT_DIR/agents/*.md` (defaults to `~/.pi/agent/agents/*.md`)
- `.claude/agents/**/*.md`
- `.pi/agents/*.md`

Create a `worker` agent for the default quickstart:

```markdown
---
name: worker
description: Implements requested changes
model: anthropic/claude-sonnet-4-6
thinking: medium
tools: read,bash,edit,write
runtime: pi
---

Implement the requested changes and verify them.
```

`runtime` may be `pi` or `claude`. Omitted model, thinking, and tools values inherit runtime defaults.

## Tool interface

The extension registers `list-agents` and a CLI-style `subagent` tool:

```text
subagent help
subagent agents
subagent runs
subagent run <agent> [--main|--isolated] -- <task>
subagent continue <runId> [--agent <agent>] [--main|--isolated] -- <task>
subagent batch [--main|--isolated] --agent <agent> --task <task> [--agent <agent> --task <task> ...]
subagent chain [--main|--isolated] --agent <agent> --task <task> [--agent <agent> --task <task> ...]
subagent status <runId>
subagent detail <runId>
subagent abort <runId|runId,runId|all>
subagent remove <runId|runId,runId|all>
```

`batch` executes independent work in parallel. `chain` executes steps sequentially and passes the previous result as reference. Runs are asynchronous in interactive mode: after launching, wait for the automatic completion or failure follow-up rather than polling immediately.

## Slash commands and shortcuts

- `/subagents` — list discovered agents and their settings.
- `/sub:main [agent|alias|runId] <task>` — run or continue with main-session context.
- `/sub:isolate [agent|alias|runId] <task>` — run or continue in a dedicated sub-session.
- `/sub:peek [runId]` — show the latest response; defaults to the latest run.
- `/sub:open [runId]` — open session replay; defaults to the latest run.
- `/sub:history` — show all run history, including removed runs.
- `/sub:rm [runId]` — remove a run, defaulting to the latest; aborts it if running.
- `/sub:clear [all]` — clear finished runs, or all runs with `all`.
- `/sub:abort [runId|all]` — abort the latest running run, a selected run, or all running runs.
- `>> [agent|runId] <task>` — visible shortcut using main-session context.
- `> [agent|runId] <task>` — hidden shortcut (interactive UI only).
- `>>> [agent|runId] <task>` — legacy hidden shortcut (interactive UI only).
- `#<runId> <task>` — continue a run.
- `>><symbol> <task>`, `><symbol> <task>`, or `>>><symbol> <task>` — select an agent through `symbolMap`.

When an agent is omitted, shortcuts and slash commands use `defaultAgent`.

## Configuration

Global configuration belongs under `subagent` in `$PI_CODING_AGENT_DIR/settings.json` (normally `~/.pi/agent/settings.json`). A nearest project `.pi/subagent.json` overrides it.

```json
{
  "subagent": {
    "claudeRuntime": "sdk",
    "defaultAgent": "worker",
    "symbolMap": {
      "?": "searcher",
      "!": "reviewer"
    }
  }
}
```

- `claudeRuntime`: `"sdk"` (default) or `"cli"`.
- `defaultAgent`: agent used when no agent is specified. Defaults to `"worker"` and must match a discovered agent.
- `symbolMap`: maps one-character input shortcuts to non-empty agent names. The default is `{}`. A valid project map replaces the global map; a malformed project map falls back to the valid global map.

## Security & trust boundary

- The Claude runtime uses `bypassPermissions` and `allowDangerouslySkipPermissions`, so it can execute commands and modify files without approval prompts.
- pi-runtime subagents are also headless and receive unrestricted access to their configured tools.
- Use this extension only in trusted repositories and with trusted agent definitions and prompts.
