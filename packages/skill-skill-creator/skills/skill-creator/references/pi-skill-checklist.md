# Pi Skill Checklist

Use this checklist when reviewing a new or modified Pi skill. Items marked
**[Pi]** reflect Pi-specific behaviour that may differ from the Agent Skills
standard.

## Required structure

- [ ] Skill is a directory containing `SKILL.md`, **or** a root-level `.md`
      file in `~/.pi/agent/skills/` / `.pi/skills/` (Pi-only shortcut).
- [ ] `SKILL.md` starts with YAML frontmatter delimited by `---`.
- [ ] `name` exists, is lowercase alphanumeric with single hyphens, ≤64 chars,
      no leading/trailing or consecutive hyphens.
- [ ] `description` exists and is **non-empty** — without it Pi refuses to load
      the skill at all.
- [ ] `description` ≤ 1024 characters.
- [ ] Optional `compatibility` ≤ 500 characters if present.
- [ ] [Pi] Name and parent directory match. Pi does not enforce this, but the
      Agent Skills standard does — keep them aligned unless you have a deliberate
      reason (e.g. a shared directory consumed by multiple harnesses).

## Frontmatter fields Pi recognises

| Field | Required | Notes |
|---|---|---|
| `name` | yes | see above |
| `description` | yes | what + when, ≤1024 chars |
| `license` | no | name or bundled-file reference |
| `compatibility` | no | env requirements, ≤500 chars |
| `metadata` | no | arbitrary key/value (ignored by Pi but kept) |
| `allowed-tools` | no | space-delimited pre-approved tools (experimental) |
| `disable-model-invocation` | no | `true` → only `/skill:<name>` can invoke |

Anything else (e.g. Claude Code's `argument-hint`) is silently dropped by Pi.

## Pi loading behaviour

- [ ] Skill is in a location Pi scans:
  - global: `~/.pi/agent/skills/`, `~/.agents/skills/`
  - project: `.pi/skills/`, `.agents/skills/` (cwd up to git root)
  - package: `pi.skills` in `package.json` or `skills/` in a package
  - settings: `skills` array in `~/.pi/settings.json` or `.pi/settings.json`
  - CLI: `pi --skill <path>` (repeatable, additive with `--no-skills`)
- [ ] User knows to run `/reload` or start a new Pi session after adding a
      global skill.
- [ ] In `.agents/` locations, the skill is a directory with `SKILL.md`
      (root `.md` files are ignored there).
- [ ] If multiple skills share the same `name`, the first one discovered wins —
      check for collisions via `rg --files -g SKILL.md` across all scan roots.
- [ ] For isolated tests, use `pi --no-skills --skill /path/to/skill -p "..."`.

## Trigger quality

- [ ] `description` says both what the skill does and when to use it.
- [ ] Includes realistic user phrases and domain keywords.
- [ ] Avoids over-broad trigger wording that would steal unrelated tasks.
- [ ] Near-miss cases are documented in the body if needed.
- [ ] If `disable-model-invocation: true`, the body explains how users should
      invoke the skill (`/skill:<name> <args>`).

## Progressive disclosure

- [ ] `SKILL.md` is concise enough to read on activation (target <500 lines).
- [ ] Long references are in `references/`.
- [ ] Deterministic/repeated work is in `scripts/`.
- [ ] Templates/examples are in `assets/`.
- [ ] Relative file references are clear and rooted at the skill directory.
- [ ] No user-specific absolute paths (`/Users/<name>/…`, `/home/<name>/…`) in
      the body.

## Safety and maintainability

- [ ] No hidden destructive commands.
- [ ] No credential exfiltration, unauthorized access, or malware-like behavior.
- [ ] Tool usage guidance matches the Pi harness, not another product's
      assumptions (no bare `claude -p`, no Anthropic eval viewer requirement).
- [ ] Final output format and validation steps are explicit.

## Evaluation

- [ ] At least 2 realistic test prompts exist when the workflow is non-trivial.
- [ ] Objective tasks have assertions or command-based checks.
- [ ] Subjective tasks rely on human review rather than fake precision.
- [ ] Findings are generalized into the skill, not overfit to one prompt.
