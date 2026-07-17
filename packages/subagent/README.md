# subagent

Asynchronous subagent delegation for [pi](https://github.com/earendil-works/pi). Run specialist agents in dedicated child sessions, share main-session context when needed, and receive results as follow-up messages.

> [!WARNING]
> Subagents run headlessly without approval prompts. Claude-runtime agents bypass permissions, and pi-runtime agents can use every tool declared by their agent definition. This extension is not a sandbox. Use trusted repositories, prompts, and agent definitions only.

## Install

Requires pi 0.80.6 or later. Compatibility is tested with pi 0.80.7.

```bash
pi install npm:@ryan_nookpi/pi-extension-subagent
```

## Quick start

Create a global agent at `~/.pi/agent/agents/worker.md`, or a project agent at `.pi/agents/worker.md`:

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

Then launch it from pi:

```text
/sub:isolate worker implement the requested change and run tests
```

Equivalent AI tool call:

```json
{ "command": "subagent run worker --isolated -- implement the requested change and run tests" }
```

Tool launches are asynchronous. Wait for the automatic completion or failure follow-up instead of polling immediately.

## Agent definitions

Agent files use YAML frontmatter followed by the system prompt. `name` and `description` are required.

| Field | Description |
| --- | --- |
| `runtime` | `pi` (default) or `claude` |
| `model` | Runtime-compatible model ID |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools` | Comma-separated tool names |

Omitted optional fields use runtime defaults.

Agents are discovered in this order; later definitions override earlier agents with the same name:

1. `$PI_CODING_AGENT_DIR/agents/*.md` (normally `~/.pi/agent/agents/*.md`)
2. Nearest `.claude/agents/**/*.md`
3. Nearest `.pi/agents/*.md`

`.claude/agents` is searched recursively. `.pi/agents` is not.

Run `/subagents`, `subagent agents`, or the `list-agents` tool to inspect discovered agents.

### Optional starter pack

If no agents are found, `/subagents` can offer an optional, opinionated starter pack. It copies nine agent templates, two example workflow skills, and missing global `subagent` settings. Existing files and configured values are not overwritten.

The starter pack is not required. Decline it if you prefer to define agents manually. It fills a missing `claudeRuntime` setting with `cli`; without that setting, the extension default is `sdk`.

## Context modes

- `--isolated` starts without copying the main conversation. It is the default for tool launches.
- `--main` passes selected main-session context to the child.
- `/sub:isolate` and `/sub:main` provide the same choice for interactive commands.
- Continuing a run preserves its original child session and context mode.

Active child processes stop when pi replaces or reloads the parent extension runtime. This follows pi's [official extension lifecycle guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#long-lived-resources-and-shutdown).

## Tool interface

The extension registers two tools:

- `list-agents` — list discovered agents and runtime settings
- `subagent` — execute a CLI-style command string

These strings are tool input, not shell commands. Do not run them in Bash.

```text
subagent help
subagent agents
subagent runs
subagent run <agent> [--main|--isolated] -- <task>
subagent continue <runId> [--agent <agent>] [--main|--isolated] -- <task>
subagent batch [--main|--isolated] --agent <agent> --task <task> ...
subagent chain [--main|--isolated] --agent <agent> --task <task> ...
subagent status <runId>
subagent detail <runId>
subagent abort <runId|runId,runId|all>
subagent remove <runId|runId,runId|all>
```

`batch` runs independent tasks in parallel:

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

Use `status` and `detail` for one-off inspection, not polling loops.

## Interactive commands

| Command | Description |
| --- | --- |
| `/subagents` | List agents and offer the starter pack when none exist |
| `/sub:main [agent\|runId] <task>` | Launch or continue with main-session context |
| `/sub:isolate [agent\|runId] <task>` | Launch or continue with isolated context |
| `/sub:peek [runId]` | Show the latest result |
| `/sub:open [runId]` | Open the child session replay |
| `/sub:history` | Show run history, including removed runs |
| `/sub:abort [runId\|all]` | Abort running work |
| `/sub:rm [runId]` | Remove a run, aborting it first if necessary |
| `/sub:clear [all]` | Clear finished runs, or all runs |

When an agent is omitted, launch commands use `defaultAgent`.

### Shortcuts

| Shortcut | Description |
| --- | --- |
| `>> [agent\|runId] <task>` | Visible run with main-session context |
| `> [agent\|runId] <task>` | Hidden run with main-session context |
| `#<runId> <task>` | Continue a run |
| `>><symbol> <task>` / `><symbol> <task>` | Run an agent from `symbolMap` |
| `<>runId` | Peek at a result |
| `<< [runId\|runId,runId]` | Abort running or clear finished runs |
| `<<< [all]` | Clear finished runs, or all runs |

Hidden runs are available only in the interactive UI and do not add start or completion messages to the main transcript.

### Prompt mentions

Use `>agent-name` inside a prompt to reference a discovered agent. Exact names are highlighted and rewritten to `subagent:agent-name` before the main LLM receives the prompt; they do not launch a run directly. Unknown names remain unchanged.

```text
Delegate implementation to >worker and review to >reviewer.
```

A mention has no space after `>`. Launch shortcuts remain separate, such as `> worker implement this`.

## Configuration

Global settings belong under `subagent` in `$PI_CODING_AGENT_DIR/settings.json`:

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

- `claudeRuntime`: `sdk` (default) or `cli`; applies only to `runtime: claude`
- `defaultAgent`: used when an interactive launch omits the agent; defaults to `worker`
- `symbolMap`: one-character shortcuts mapped to agent names; a valid project map replaces the global map

Set `PI_SUBAGENT_CONTEXT_GUARD_TOKENS` to a positive integer to override the proactive context limit for pi-runtime children. Set it to `0` or an empty value to disable the guard.

## Claude runtime

The default Claude runtime uses the Claude Agent SDK and requires supported Anthropic authentication such as `ANTHROPIC_API_KEY`; see the [official Claude Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/overview).

For `claudeRuntime: "cli"`, install the `claude` executable, ensure it is on `PATH`, and authenticate Claude Code.

## Escalation

Pi-runtime children receive an `ask_master` tool. Calling it reports a decision or blocker to the parent and immediately terminates the child run. Use it only when the child cannot proceed safely.

Claude-runtime children do not receive `ask_master`; they report blockers in their final response.

## Troubleshooting

- **`Configured defaultAgent "worker" was not found`** — create a matching agent, choose another agent explicitly, or update `defaultAgent`.
- **Claude SDK authentication failure** — confirm the environment that starts pi contains valid Anthropic authentication.
- **`spawn claude ENOENT`** — install Claude Code or switch `claudeRuntime` to `sdk`.
- **Hidden run shows no transcript message** — inspect it with `/sub:peek`, `<>runId`, or `/sub:open`.

When reporting a bug, include the pi and extension versions, OS and Node version, launch command, reproduction steps, and sanitized error output. Do not attach full session files because they may contain prompts, tool output, or secrets.

## Security

- Claude SDK uses permission bypass; Claude CLI uses `--dangerously-skip-permissions`.
- Pi-runtime children can use every tool declared by their agent.
- Project agent definitions are repository-controlled instructions. Review `.pi/agents` and `.claude/agents` in unfamiliar repositories.
- Restrict each agent's `tools` list to the minimum required.
- `--isolated` separates conversation context, not filesystem, process, credential, or network access.

## Stability

This package is pre-1.0. Documented commands, configuration, and agent frontmatter are the supported surface; internal TypeScript modules may change between releases.

## License

MIT
