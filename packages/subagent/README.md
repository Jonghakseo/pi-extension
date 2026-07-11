# subagent

Asynchronous subagent delegation for [pi](https://github.com/earendil-works/pi). Run specialist agents in dedicated child sessions, optionally pass selected main-session context, and receive results as follow-up messages.

> [!WARNING]
> Subagents run headlessly without approval prompts. Claude-runtime agents use permission bypass, and pi-runtime agents can use every tool listed in their agent definition. This extension is not a sandbox. Use it only in trusted repositories with trusted prompts and agent definitions.

## Requirements

- pi 0.80.6 or later (tested with 0.80.6)
- For `runtime: claude` with the default `claudeRuntime: "sdk"`: supported Anthropic authentication such as `ANTHROPIC_API_KEY`; see the [official Claude Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/overview)
- For `runtime: claude` with `claudeRuntime: "cli"`: the `claude` executable on `PATH` and an authenticated Claude Code installation

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-subagent
```

## Quick start

### 1. Discover or seed agents

Run this from the interactive pi UI:

```text
/subagents
```

If no agent definitions exist in any discovery location, the extension offers an optional starter pack containing:

- Nine portable English agents: `browser`, `challenger`, `code-cleaner`, `reviewer`, `searcher`, `security-auditor`, `simplifier`, `verifier`, and `worker`
- The `stress-interview` and `self-healing` skills, written in English and validated against the [Agent Skills specification](https://agentskills.io/specification)
- Missing global `subagent` settings: `defaultAgent: "worker"`, `claudeRuntime: "cli"`, and symbol mappings for searcher, challenger, and browser

Seeded agents intentionally omit model IDs and inherit the user's Pi model. Existing files and configured setting values are never overwritten. If the offer is declined, nothing is recorded or written, so the extension asks again the next time the list is still empty.

Agents and subagent settings are available immediately after installation. Run `/reload` or start a new Pi session to activate the two newly copied skills. Headless sessions never install automatically; they return instructions to run `/subagents` interactively.

The same offer is available from either agent-list tool:

```json
{ "command": "subagent agents" }
```

The separate `list-agents` tool behaves the same way. The `subagent ...` examples in this README are **tool command strings**, not terminal commands. Do not run them in Bash.

### 2. Or create an agent manually

Agents are Markdown files with YAML frontmatter. Create `~/.pi/agent/agents/worker.md` for a global agent, or `.pi/agents/worker.md` inside one project:

```markdown
---
name: worker
description: Implements requested changes
thinking: medium
tools: read,bash,edit,write
runtime: pi
---

Implement the requested changes and verify them.
```

`name` and `description` are required. Optional fields are:

- `runtime`: `pi` (default) or `claude`
- `model`: runtime-compatible model ID
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`
- `tools`: comma-separated tool names

Omitted model, thinking, and tools values use that runtime's defaults.

### 3. Launch a run

Interactive user command:

```text
/sub:isolate worker implement the requested change and run tests
```

Equivalent AI tool call:

```json
{ "command": "subagent run worker --isolated -- implement the requested change and run tests" }
```

Runs are asynchronous in interactive mode. Wait for the automatic completion or failure follow-up instead of immediately polling `status` or `detail`.

## Agent discovery

Definitions are loaded from the following locations. Later sources override earlier agents with the same name:

1. `$PI_CODING_AGENT_DIR/agents/*.md` (normally `~/.pi/agent/agents/*.md`)
2. Nearest `.claude/agents/**/*.md`
3. Nearest `.pi/agents/*.md`

Project `.claude/agents` files are discovered recursively. Project `.pi/agents` files are discovered only in the selected directory.

## Context modes and lifecycle

- `--isolated` starts a dedicated child session without copying the main conversation. It is the default for `subagent` tool launches.
- `--main` adds selected main-session context to the child task.
- `/sub:isolate` selects isolated context; `/sub:main` selects main context.
- `>>` and `>` use main-session context.
- Continuing a run preserves its original context mode and child session. Supplying `--main` or `--isolated` to `continue` does not retroactively change it.

Pi replaces and invalidates extension runtimes during `/new`, `/resume`, `/fork`, and reload. Active child processes are therefore aborted during `session_shutdown`, and the old session records why they stopped. Wait for active runs before replacing the parent session. This follows pi's [official extension lifecycle guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#long-lived-resources-and-shutdown).

## Tool interface

The extension registers two main-session tools:

- `list-agents`: return discovered agent definitions and runtime settings
- `subagent`: accept one CLI-style command string

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

`batch` runs independent tasks in parallel. Quote tasks containing spaces:

```json
{
  "command": "subagent batch --main --agent worker --task \"implement feature A\" --agent reviewer --task \"review feature B\""
}
```

`chain` runs steps sequentially and gives each step the previous result as reference:

```json
{
  "command": "subagent chain --isolated --agent worker --task \"implement the change\" --agent reviewer --task \"review the implementation\""
}
```

Use `status` and `detail` only for explicit, one-off inspection. Repeated polling is unnecessary because completion is delivered automatically.

## Slash commands

- `/subagents` — list discovered agents and settings
- `/sub:main [agent|alias|runId] <task>` — launch with main-session context or continue a run
- `/sub:isolate [agent|alias|runId] <task>` — launch in isolated context or continue a run
- `/sub:peek [runId]` — show the latest response; defaults to the latest run
- `/sub:open [runId]` — open session replay; defaults to the latest run
- `/sub:history` — show all run history, including removed runs
- `/sub:rm [runId]` — remove a run; defaults to the latest and aborts it if necessary
- `/sub:clear [all]` — clear finished runs, or every run with `all`
- `/sub:abort [runId|all]` — abort the latest running run, one run, or all running runs

When an agent is omitted, launch commands use `defaultAgent`.

## Interactive shortcuts

| Shortcut | Behavior |
| --- | --- |
| `>> [agent\|runId] <task>` | Visible run using main-session context |
| `> [agent\|runId] <task>` | Hidden run using main-session context; interactive UI only |
| `#<runId> <task>` | Continue a run |
| `>><symbol> <task>` | Visible run using the agent mapped in `symbolMap` |
| `><symbol> <task>` | Hidden run using the mapped agent |
| `<>runId` | Compact form of `/sub:peek runId` |
| `<< [runId\|runId,runId]` | Abort selected running runs or clear selected finished runs; without arguments, abort the latest running run |
| `<<< [all]` | Clear finished runs; use `all` to clear every run |

Hidden runs do not add start or completion messages to the main transcript. Read their output with `/sub:peek`, `<>runId`, or `/sub:open`. A plain `>` shortcut requires a space before its task; configured symbol shortcuts do not.

## Escalation from pi-runtime agents

Pi-runtime subagent sessions receive an `ask_master` tool. It lets a child report a decision that the parent must make, then immediately terminates that child run. The parent receives the escalation as a follow-up.

Use `ask_master` only when the child cannot safely proceed, such as before a destructive operation or an unresolved architecture decision. Claude-runtime agents do not receive this tool; they report blockers in their final text instead.

## Configuration

Global configuration belongs under `subagent` in `$PI_CODING_AGENT_DIR/settings.json` (normally `~/.pi/agent/settings.json`):

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

A nearest project `.pi/subagent.json` overrides global values:

```json
{
  "defaultAgent": "worker",
  "symbolMap": {
    "?": "searcher"
  }
}
```

- `claudeRuntime`: `sdk` (default) or `cli`; applies only to agents with `runtime: claude`
- `defaultAgent`: agent used when a launch omits its agent; defaults to `worker` and must match a discovered definition
- `symbolMap`: one-character shortcuts mapped to non-empty agent names; a valid project map replaces the global map as a whole, while a malformed project map falls back to the valid global map

### Context guard override

`PI_SUBAGENT_CONTEXT_GUARD_TOKENS` overrides the proactive context limit for pi-runtime children. Set it to a positive integer to apply that ceiling to every pi model. Set it to `0` or an empty value to disable the proactive guard and rely on native compaction or provider overflow handling.

## Troubleshooting

### `Configured defaultAgent "worker" was not found`

Create a `worker` definition from the quick start, choose an existing agent explicitly, or change `defaultAgent`. Run `/subagents` to verify discovery before launching.

### Claude SDK authentication failure

Confirm the environment used to start pi has valid Anthropic authentication, such as `ANTHROPIC_API_KEY`. The SDK runtime does not require the Claude Code CLI.

### `spawn claude ENOENT`

`claudeRuntime` is set to `cli`, but the `claude` executable is not on `PATH`. Install and authenticate Claude Code, or switch back to `claudeRuntime: "sdk"`.

### Hidden shortcut produces no transcript message

That is intentional. Hidden `>` runs are human-only UI jobs. Inspect them with `/sub:peek`, `<>runId`, or `/sub:open`.

## Security and trust boundary

- Claude SDK execution uses `permissionMode: "bypassPermissions"` with `allowDangerouslySkipPermissions`; Claude CLI execution uses `--dangerously-skip-permissions`.
- Pi-runtime children are headless and have unrestricted access to the tools declared by their agent.
- Project agent definitions are repository-controlled instructions. Review `.pi/agents` and `.claude/agents` before running this extension in an unfamiliar repository.
- Restrict each agent's `tools` list to what it needs. Avoid broad shell or write access for read-only review agents.
- `--isolated` separates conversation context; it does not provide filesystem, process, credential, or network isolation.

## Stability

This is a `0.1.x` release. The commands, configuration keys, agent frontmatter, and behaviors documented here are the supported surface. Internal TypeScript modules included in the npm tarball are implementation details and may change during the `0.x` series. Compatibility is currently tested against pi 0.80.6.

## License

MIT
