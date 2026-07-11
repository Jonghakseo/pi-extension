---
name: self-healing
description: Run a bounded two-cycle review-and-repair loop using stress-interview and worker. Use when a user requests self-healing, automatic review fixes, or a review-repair-recheck workflow.
disable-model-invocation: false
---

# self-healing

Run at most two review-and-repair cycles for `$ARGUMENTS`.

- Cycle 1: `stress-interview` -> targeted `worker` fixes
- Cycle 2: `stress-interview` -> targeted `worker` fixes

Never continue indefinitely.

## Purpose

- Reduce defects and unverified assumptions after an initial implementation.
- Apply only concrete, evidence-backed findings.
- Bound automation so scope and risk remain understandable.

## Workflow

1. Define the exact target scope in one or two sentences.
2. Run the stress-interview workflow with one `subagent batch` containing `verifier`, `reviewer`, and `challenger`.
3. Classify findings:
   - Fix now automatically: reproducible and narrowly actionable
   - Escalate: high-impact issue requiring a product, security, or architecture decision
   - Improve if safe: lower-severity clarity, maintainability, or test gap
   - Report only: weak evidence, intentional behavior, or out-of-scope redesign
4. Send only approved actionable items to `worker` using the Pi `subagent` tool.
5. Verify the worker's actual diff and validation output.
6. Repeat the stress interview once more.
7. Apply a second bounded worker pass only for remaining actionable items.
8. Stop after Cycle 2 or earlier when no actionable findings remain.

## Subagent invocations

Run each review pass with a command shaped like:

```text
subagent batch --main --agent verifier --task "Verify $ARGUMENTS with executable evidence." --agent reviewer --task "Review $ARGUMENTS for correctness and regressions." --agent challenger --task "Pressure-test $ARGUMENTS with at most three high-impact questions."
```

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

1. `Cycle 1` — findings and applied changes
2. `Cycle 2` — findings and applied changes
3. `Remaining Risks`
4. `Recommendation`

## Validation checklist

- No more than two cycles ran.
- Every worker change maps to an evidence-backed finding.
- The actual diff was checked after each worker pass.
- Relevant tests, type checking, linting, or runtime checks were run.
- Remaining risks and decision-dependent items are explicit.
