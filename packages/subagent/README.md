# subagent

Asynchronous subagent delegation for [pi](https://github.com/badlogic/pi-mono). Run specialist agents in isolated sessions or with selected main-session context, then receive completion results as follow-up messages.

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-subagent
```

The pi CLI is required. The default Claude runtime also requires the Claude Code CLI and uses `@anthropic-ai/claude-agent-sdk`, which is installed with this package.

## Agent definitions

Agents are discovered from these locations, with project definitions taking precedence:

- `~/.pi/agent/agents/*.md`
- `.claude/agents/*.md`
- `.pi/agents/*.md`

Example:

```markdown
---
name: reviewer
description: Reviews changes for correctness and regressions
model: anthropic/claude-sonnet-4-6
thinking: medium
tools: read,bash
runtime: pi
---

Review the requested changes. Report findings with file and line references.
```

`runtime` may be `pi` or `claude`. Omitted model, thinking, and tools values inherit runtime defaults.

## Tool interface

The extension registers `list-agents` and a CLI-style `subagent` tool:

```text
subagent agents
subagent runs
subagent run worker -- implement the feature
subagent run reviewer --main -- review the current changes
subagent continue 22 -- address the review findings
subagent batch --isolated --agent searcher --task "inspect API usage" --agent reviewer --task "review tests"
subagent chain --main --agent worker --task "implement the change" --agent reviewer --task "review the result"
subagent status 22
subagent detail 22
subagent abort 22
subagent remove 22
```

`batch` executes independent work in parallel. `chain` executes steps sequentially and passes the previous result as reference. Runs are asynchronous in interactive mode: after launching, wait for the automatic completion or failure follow-up rather than polling immediately.

## Slash commands and shortcuts

- `/sub:main [agent|runId] <task>` — run with main-session context
- `/sub:isolate [agent|runId] <task>` — run in a dedicated sub-session
- `/sub:hidden [agent|runId] <task>` — interactive hidden run without a main-agent follow-up
- `/sub:peek [runId]` — inspect the latest response
- `/sub:status`, `/sub:detail`, `/sub:runs`, `/sub:abort`, `/sub:remove`
- `>> <task>` and `> <task>` — input shortcuts; configured symbols can select an agent

Use `subagent help` for the complete tool syntax.

## Configuration

Global configuration belongs under `subagent` in `~/.pi/agent/settings.json`. A nearest project `.pi/subagent.json` overrides it.

```json
{
  "subagent": {
    "claudeRuntime": "sdk",
    "symbolMap": {
      "?": "searcher",
      "!": "reviewer"
    }
  }
}
```

- `claudeRuntime`: `"sdk"` (default) or `"cli"`.
- `symbolMap`: maps one-character input shortcuts to agent names. The default is `{}`. Project configuration replaces the global map when provided.
