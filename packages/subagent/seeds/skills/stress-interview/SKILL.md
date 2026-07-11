---
name: stress-interview
description: Run verifier, reviewer, and challenger in parallel to pressure-test a change before release. Use when a user requests multi-angle review, release readiness, adversarial validation, or a stress interview.
disable-model-invocation: false
---

# stress-interview

Cross-review `$ARGUMENTS` with `verifier`, `reviewer`, and `challenger` in parallel.

## Purpose

- Collect executable verification, code-review findings, and skeptical risk questions at the same time.
- Reduce single-reviewer bias by comparing overlap and disagreement.
- Produce a release-oriented decision with evidence and remaining risk.

## Workflow

1. Restate the review target in one or two sentences.
2. Use the Pi `subagent` tool, not a shell command.
3. If the tool interface is unclear, call `subagent help` first.
4. Launch one parallel batch:
   - `verifier`: tests, type checking, builds, reproduction, and concrete evidence
   - `reviewer`: correctness, regressions, security, and maintainability
   - `challenger`: assumptions, failure scenarios, and weak decision points
5. Wait for automatic completion messages. Do not poll immediately with `status` or `detail`.
6. Compare the three results:
   - Common findings: independently identified by at least two agents
   - Independent findings: identified by one agent but supported by evidence
   - Conflicts: materially different conclusions that require explanation
7. Distinguish verified defects from challenger hypotheses.

## Tool invocation

Use a command shaped like this:

```text
subagent batch --main --agent verifier --task "Verify $ARGUMENTS with executable evidence." --agent reviewer --task "Review $ARGUMENTS for correctness, regressions, security, and maintainability." --agent challenger --task "Pressure-test $ARGUMENTS. Return at most three high-impact skeptical questions with evidence and impact."
```

Use `--isolated` instead of `--main` when the tasks are fully self-contained and should not inherit the current conversation.

## Two-pass mode

When `$ARGUMENTS` includes `--2pass` or explicitly requests a two-pass review:

### Pass 1: specification compliance

- Ask `verifier` whether implementation matches the stated requirements.
- Ask `reviewer` to find missing requirements and unnecessary scope.
- Classify findings as under-built or over-built.
- Resolve material specification gaps before Pass 2.

### Pass 2: code quality

- Ask `reviewer` for correctness, regression, security, and maintainability findings.
- Ask `challenger` for assumptions and failure scenarios.
- Re-run Pass 2 after critical or important fixes; record minor items without blocking.

## Severity

- Must fix: blocker, correctness failure, security issue, data loss, or reproducible regression
- Should fix: maintainability, clarity, test gaps, or low-risk improvement
- Remaining risk: decision-dependent, weakly evidenced, or intentionally deferred concern

## Output format

1. `Overall` — Ready | Needs changes | Blocked
2. `Common Findings`
3. `Verifier`
4. `Reviewer`
5. `Challenger`
6. `Severity Classification`
7. `Recommended Next Step`

## Validation checklist

- All three agents completed or their failure is explicitly reported.
- Verification claims include commands or reproducible evidence.
- Challenger questions are labeled as hypotheses unless proven.
- Conflicting conclusions are shown rather than silently resolved.
- The final decision does not claim certainty beyond the evidence.
