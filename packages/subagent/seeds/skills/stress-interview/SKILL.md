---
name: stress-interview
description: Use when the user wants a change pressure-tested from multiple angles before release.
compatibility: Requires the subagent extension and the `verifier`, `reviewer`, and `challenger` agents. Run `/subagents` to install the starter pack when they are missing.
---

# stress-interview

Cross-review one target with `verifier`, `reviewer`, and `challenger` in parallel.

## Purpose

- Collect executable verification, code-review findings, and skeptical risk questions at the same time.
- Reduce single-reviewer bias by comparing overlap and disagreement.
- Produce a release-oriented decision with evidence and remaining risk.

## Workflow

1. Restate the review target in one or two sentences, such as "the staged diff in `packages/subagent`" or "PR #142". This restated sentence is what you paste into every `--task` below. There is no `$ARGUMENTS` substitution in skills; the user text, if any, arrives after the skill instructions.
2. Confirm the prerequisites once, before launching:
   - Call `subagent agents` and check that `verifier`, `reviewer`, and `challenger` exist.
   - If any are missing, tell the user to run `/subagents` and install the starter pack, then `/reload`. Do not substitute a single agent for the three-way review.
   - If the tool interface is unclear, call `subagent help` first.
3. Launch one parallel batch:
   - `verifier`: tests, type checking, builds, reproduction, and concrete evidence
   - `reviewer`: correctness, regressions, security, and maintainability
   - `challenger`: assumptions, failure scenarios, and weak decision points
4. Wait for automatic completion messages. Do not poll immediately with `status` or `detail`.
5. Compare the three results:
   - Common findings: independently identified by at least two agents
   - Independent findings: identified by one agent but supported by evidence
   - Conflicts: materially different conclusions that require explanation
6. Distinguish verified defects from challenger hypotheses.

## Tool invocation

`subagent` is a Pi tool, not a shell command. Never run these strings in Bash. The tool takes a single `command` string:

```json
{
  "command": "subagent batch --main --agent verifier --task \"Verify the staged diff in packages/subagent with executable evidence.\" --agent reviewer --task \"Review the staged diff in packages/subagent for correctness, regressions, security, and maintainability.\" --agent challenger --task \"Pressure-test the staged diff in packages/subagent. Return at most three high-impact skeptical questions with evidence and impact.\""
}
```

Replace the quoted target with the sentence from step 1. The shape of the command is:

```text
subagent batch --main --agent verifier --task "Verify <target> with executable evidence." --agent reviewer --task "Review <target> for correctness, regressions, security, and maintainability." --agent challenger --task "Pressure-test <target>. Return at most three high-impact skeptical questions with evidence and impact."
```

Place the context flag before the first `--agent`. Use `--isolated` instead of `--main` when the tasks are fully self-contained, for example a named PR or a path the agents can read themselves. Use `--main` when the review depends on decisions made earlier in this conversation.

## Two-pass mode

Run two passes when the user text that follows this skill contains `--2pass`, or when the user explicitly asks for a two-pass review. Skills receive that text as plain trailing input, so read it instead of expecting a substituted variable.

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

1. `Overall` - Ready | Needs changes | Blocked
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
