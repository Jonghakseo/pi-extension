# task

Asynchronous task delegation with a persistent Pi RPC worker per Task. The parent supplies an instruction; a separate evaluator chooses `fast`, `balanced`, or `powerful`, then a configurable preset selects the worker model and thinking level.

This is a separate package. It does not replace `subagent`.

## Requirements

Pi 1.1.0 or later, with credentials for the evaluation and execution models. Workers use the installed Pi CLI and normally discover the same user and project extensions as the parent. Install `bash-async` separately if workers should use it.

> This extension is not a sandbox. Workers share the working directory, inherit credentials and tools, and may modify files concurrently. `readonly` is an instruction, not an enforced permission boundary. Assign non-overlapping write scopes when possible.

## Task tool

Create a Task and get its ID immediately:

```json
{ "task": "Investigate the login failure and verify a fix" }
```

Add instructions to a running Task:

```json
{ "action": "edit", "taskId": "task-...", "task": "Only change email login; leave social login alone" }
```

Other actions:

```json
{ "task": "Review the authentication flow without changing anything", "readonly": true }
{ "action": "list" }
{ "action": "detail", "taskId": "task-..." }
{ "action": "abort", "taskId": "task-..." }
{ "action": "resume", "taskId": "task-...", "task": "Continue from the saved context" }
```

Do not poll to wait for a result. Final reports arrive automatically at the parent model's next response/tool boundary. When the parent is idle, a report starts a new turn without aborting the parent.

Task control is available to the parent agent through the `Task` tool only. No user-facing slash commands are registered; ask the parent agent to list, edit, abort, or resume a Task.

## Worker lifecycle

```text
Task creation -> evaluation -> preset -> concurrency queue -> persistent RPC worker
                                                           |
                              background job -> wait -> completion -> continue
                                                           |
                                              task_report -> parent report
```

The default concurrency limit is four active Tasks, including workers waiting for background jobs. Extra Tasks wait in the queue. A normal assistant response, `agent_end`, or `agent_settled` does not complete a Task.

After a revision has been executing for 30 minutes, the parent receives one progress notice. Background-job waiting time counts; concurrency queue time does not. This notice neither completes the Task nor interrupts the model or its background jobs. An edit or explicit resume starts a fresh 30-minute window when the revised input reaches the worker. Completion and parent shutdown cancel pending notices; outdated notices are excluded from the parent's model context.

Only the child receives `task_report`. It must explicitly report the current revision, a `success`, `failed`, or `blocked` outcome, a summary, artifacts, verification, and blockers. The parent accepts validated reports for the current Task/revision and closes the worker after final handoff. The child should finish or deliberately stop its background jobs before reporting: closing the worker invokes its extensions' shutdown handlers.

`edit` invalidates old reports immediately, interrupts the current model operation, reevaluates the revised instructions, and continues the same RPC session with the selected model and thinking level. Existing file changes and conversation history are preserved. Edits are additive; later instructions override conflicting earlier instructions.

`abort` interrupts only the current model operation. It does **not** kill the RPC worker or cancel its detached `bash_async` jobs. A later background completion may wake that worker again. Background job management belongs to the child session, not the parent Task manager.

A parent session shutdown closes its RPC workers. Unfinished Tasks become `interrupted`; reopening the same parent session shows one recovery notice without automatically restarting them. Explicit resume reuses the saved child session. This is session-bound execution, not a daemon that survives closing Pi.

Task records and child sessions live under Pi's agent directory, partitioned by parent session ID. These files contain conversation content and should be treated as private.

## Context and tools

A compact, reference-bearing snapshot of the active parent conversation is supplied to the child, following the brief-and-recall approach used by `vcc-ko`. `task_context` lets the worker search and expand original snapshot text. The snapshot is refreshed on an explicit edit; it does not silently follow later parent messages or other branches.

Normal Pi extensions and tools remain available, including memory and web search when installed. Known recursive delegation through `Task`, `task`, and `subagent` is blocked. Unknown delegation tools are prohibited by instructions only. Read-only workers are instructed not to change files, saved memories, or external systems; read-oriented shell commands remain possible.

RPC supports extension dialogs through its UI protocol, but not every TUI feature. Task cancels unattended input/approval dialogs and reports the missing interaction to the parent instead of approving them. Supply the decision through a Task edit.

## Evaluation and configuration

The default evaluator is a lightweight chat model from the parent provider family: Luna for GPT/Codex and Haiku for Claude. Classifier preference is opt-in. When enabled, an available classifier is tried first; unavailability or a failed classifier call falls back to the configured chat evaluator. Cancellation is not a fallback condition.

The evaluator chooses only the tier. The preset controls the actual execution model and thinking level. Defaults use Luna/Sol/Astra for GPT and Haiku/Sonnet/Opus for Claude, with low/medium/high thinking respectively; they do not simply reuse the parent model for every tier. Invalid evaluation responses and unavailable execution presets produce a failure report rather than silently escalating to a more expensive model. Pi handles its configured transient provider retries; Task does not automatically retry failed work or promote it to a stronger tier.

Global configuration belongs under `task` in Pi's `settings.json`; project overrides belong in the nearest `.pi/task.json`. Provider/model IDs must match the models available in the installed Pi instance.

A project configuration can select its own models:

```json
{
  "maxConcurrency": 4,
  "preferClassifier": false,
  "evaluator": {
    "provider": "openai-codex",
    "model": "gpt-6-luna",
    "thinking": "low"
  },
  "presets": {
    "fast": { "provider": "openai-codex", "model": "gpt-6-luna", "thinking": "low" },
    "balanced": { "provider": "openai-codex", "model": "gpt-6-sol", "thinking": "medium" },
    "powerful": { "provider": "openai-codex", "model": "gpt-6-astra", "thinking": "high" }
  }
}
```

Set `preferClassifier` to `true` to opt in. An optional `classifier` object such as `{ "provider": "typesafe", "model": "jev-latest" }` pins the classifier. Without it, the evaluator selects from Pi's authenticated classifier list. API credentials remain in Pi's normal credential storage or environment, not this file.

`evaluatorFallbacks` maps provider IDs to model selections. Explicit evaluator selection is tried first, then the parent provider's fallback, other authenticated fallback entries, and finally the parent model. Unknown provider defaults reuse that parent's model at different thinking levels rather than guessing proxy-specific IDs. Configure explicit presets when this is not desirable. The concurrency setting takes effect when the parent Task manager starts; model routing settings are read for each evaluation.

## Run the offline PoC

From this repository:

```bash
pnpm exec vitest run packages/task/poc.test.ts
pnpm exec vitest run packages/task
```

The full-path PoC starts a real parent Pi RPC process with this extension, evaluates a Task through a deterministic local provider, launches a real child RPC worker and `bash_async` command, edits the Task while that command is running, changes the execution model, and receives one revision-2 `task_report` in the parent. It uses isolated agent directories and no paid model APIs. This validates orchestration, not the quality of real model routing or provider-specific context conversion.

## PoC boundaries

- Shared-workspace writes are not conflict-isolated.
- No automatic task decomposition, recursive delegation, or automatic model escalation.
- Read-only mode is guidance, not a security guarantee.
- No independent daemon or automatic restart after parent shutdown.
- No task-wide execution-time, turn, or spending limit in this initial PoC. The 30-minute progress notice is not a cutoff. RPC control requests and evaluation have bounded waits; these are not task budgets.
- Authentication detection cannot guarantee a provider will accept the next request.
- Generic extension-owned background work is not automatically discoverable. Workers are responsible for finishing it before calling `task_report`.

## References

- [Pi RPC lifecycle and commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Pi classifier models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#use-classifier-models)
- [Pi extension lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
