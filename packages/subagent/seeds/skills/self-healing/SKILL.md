---
name: self-healing
description: Use when the user asks for self-healing, an automatic review-fix-recheck loop on a change.
compatibility: Requires the subagent extension and the `verifier`, `reviewer`, `challenger`, and `worker` agents. Run `/subagents` to install the starter pack when they are missing.
---

# self-healing

Run at most two review-and-repair cycles on the review target the user asked about.

- Cycle 1: `stress-interview` -> targeted `worker` fixes
- Cycle 2: `stress-interview` -> targeted `worker` fixes

Never continue indefinitely.

## Purpose

- Reduce defects and unverified assumptions after an initial implementation.
- Apply only concrete, evidence-backed findings.
- Bound automation so scope and risk remain understandable.

## Workflow

1. Restate the review target in one or two sentences, such as "the staged diff in `packages/subagent`" or "PR #142". This restated sentence is what you paste into every `--task` below. There is no `$ARGUMENTS` substitution in skills; the user text, if any, arrives after the skill instructions.
2. Confirm the prerequisites once, before the first batch:
   - Call `subagent agents` and check that `verifier`, `reviewer`, `challenger`, and `worker` exist.
   - If any are missing, tell the user to run `/subagents` and install the starter pack, then `/reload`. Do not fake the review with a single agent.
3. Run the stress-interview workflow with one `subagent batch` containing `verifier`, `reviewer`, and `challenger`.
4. Classify findings:
   - Fix now automatically: reproducible and narrowly actionable
   - Escalate: high-impact issue requiring a product, security, or architecture decision
   - Improve if safe: lower-severity clarity, maintainability, or test gap
   - Report only: weak evidence, intentional behavior, or out-of-scope redesign
5. Send only approved actionable items to `worker`.
6. Verify the worker's actual diff and validation output.
7. Repeat the stress interview once more.
8. Apply a second bounded worker pass only for remaining actionable items.
9. Stop after Cycle 2 or earlier when no actionable findings remain.

## Subagent invocations

`subagent` is a Pi tool, not a shell command. Never run these strings in Bash. The tool takes a single `command` string:

```json
{
  "command": "subagent batch --main --agent verifier --task \"Verify the uncommitted diff in packages/subagent with executable evidence.\" --agent reviewer --task \"Review the uncommitted diff in packages/subagent for correctness and regressions.\" --agent challenger --task \"Pressure-test the uncommitted diff in packages/subagent with at most three high-impact questions.\""
}
```

Replace the quoted target with the sentence from step 1. The shape of each review pass is:

```text
subagent batch --main --agent verifier --task "Verify <target> with executable evidence." --agent reviewer --task "Review <target> for correctness and regressions." --agent challenger --task "Pressure-test <target> with at most three high-impact questions."
```

`--main` is fixed for this workflow: every cycle depends on what was already decided, attempted, and rejected in this conversation, and an isolated child would re-litigate it. Place `--main` before the first `--agent`.

Then send only verified findings to the worker:

```text
subagent run worker --main -- Apply only these verified Cycle 1 findings with minimal changes: <finding list>. Run targeted validation and report exact files changed.
```

Do not send speculative challenger questions to the worker as confirmed defects. Wait for automatic completion messages instead of polling immediately.

## Fix policy

- P0/P1 with a safe, mechanical fix: fix immediately.
- P0/P1 requiring judgment: stop and ask the user.
- P2/P3 with a small, behavior-preserving fix: apply when it stays in scope.
- Informational or weakly evidenced items: report as remaining risk.
- Large refactors, product decisions, and security tradeoffs require explicit approval.

## Stop conditions

Stop when any condition is met:

- Two cycles completed
- No actionable findings remain
- A required decision cannot be made safely
- Worker cannot stay within the approved scope
- Verification cannot be completed

## Output format

| Cycle | Finding | Severity | Action | Status |
| --- | --- | --- | --- | --- |
| 1 | ... | P1 | Worker fix | Fixed |
| 2 | ... | P2 | Remaining risk | Open |

Then include:

1. `Cycle 1` - findings and applied changes
2. `Cycle 2` - findings and applied changes
3. `Remaining Risks`
4. `Recommendation`

## Validation checklist

- No more than two cycles ran.
- Every worker change maps to an evidence-backed finding.
- The actual diff was checked after each worker pass.
- Relevant tests, type checking, linting, or runtime checks were run.
- Remaining risks and decision-dependent items are explicit.
