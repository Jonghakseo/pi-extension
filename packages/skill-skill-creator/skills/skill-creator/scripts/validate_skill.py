#!/usr/bin/env python3
"""Validate a Pi/Agent Skills skill directory.

Stdlib-only so the skill runs without setup. Checks the constraints that most
often break Pi skill loading, plus quality warnings (short descriptions,
broken relative paths, absolute paths, unknown frontmatter fields, etc.).

Exit codes:
  0  no errors (warnings allowed)
  1  at least one error
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Dict, List, Tuple

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

# Fields Pi actively recognises (per docs/skills.md). Unknown fields are
# silently ignored by Pi but we surface them as info to catch typos.
KNOWN_FIELDS = {
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
    "disable-model-invocation",
}

REQUIRED_FIELDS = {"name", "description"}

# Hard-fail threshold (Pi refuses to load).
MAX_DESCRIPTION = 1024
MAX_NAME = 64
MAX_COMPATIBILITY = 500

# Soft warnings.
MIN_DESCRIPTION_LEN = 40
SOFT_LINE_LIMIT = 500

# Body link patterns: things that look like skill-relative resource refs.
# We deliberately skip refs inside inline code (backticks) and fenced code
# blocks because those are typically illustrative examples, not real paths.
RELPATH_RE = re.compile(
    r"(?<![\w/`])((?:scripts|references|assets)/[A-Za-z0-9_./-]+)"
)
FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
# Absolute paths that pin the skill to one machine/user.
ABS_PATH_RE = re.compile(r"(?<![\w`])(/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+)")


def parse_frontmatter(text: str) -> Tuple[Dict[str, object], List[str], List[str]]:
    """Parse a tiny subset of YAML frontmatter.

    Supports `key: value` (with optional surrounding quotes) and `key: true|false`.
    Detects unsupported structures (multi-line scalars, nested mappings, sequences)
    and reports them as warnings so authors know the value may not parse the way
    they expect when Pi loads the skill.
    """
    errors: List[str] = []
    warnings: List[str] = []
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, ["SKILL.md must start with YAML frontmatter delimiter '---'"], warnings

    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}, ["SKILL.md frontmatter is missing closing '---'"], warnings

    data: Dict[str, object] = {}
    current_key: str | None = None
    for raw in lines[1:end]:
        if not raw.strip() or raw.strip().startswith("#"):
            current_key = None
            continue

        # Continuation line (leading whitespace) — flag as unsupported scalar.
        if raw.startswith((" ", "\t")) and current_key is not None:
            warnings.append(
                f"frontmatter '{current_key}' uses multi-line/nested YAML; "
                "Pi's parser may collapse this. Keep values on a single line."
            )
            continue

        if ":" not in raw:
            errors.append(f"Unsupported frontmatter line (expected key: value): {raw}")
            current_key = None
            continue

        key, value = raw.split(":", 1)
        key = key.strip()
        value = value.strip()

        # Detect block scalars / sequences before stripping quotes.
        if value in ("|", ">", ""):
            warnings.append(
                f"frontmatter '{key}' uses block scalar or empty value; "
                "use a single-line string instead."
            )
        if value.startswith("["):
            # Inline sequence — leave as-is, callers that need it (allowed-tools)
            # will validate further.
            pass
        if value.startswith(("\"", "'")) and value[-1:] == value[:1] and len(value) >= 2:
            value = value[1:-1]

        data[key] = value
        current_key = key
    return data, errors, warnings


def _check_name(name: str, skill_dir: Path, errors: List[str], warnings: List[str]) -> None:
    if not name:
        errors.append("Missing required frontmatter field: name")
        return
    if len(name) > MAX_NAME:
        errors.append(f"name exceeds {MAX_NAME} characters: {len(name)}")
    if not NAME_RE.match(name):
        errors.append(
            "name must use lowercase letters, numbers, and single hyphens only "
            "(no leading/trailing or consecutive hyphens)"
        )
    if name != skill_dir.name:
        # Pi accepts mismatched names (warning only); Agent Skills standard requires match.
        warnings.append(
            f"name does not match parent directory (name={name!r}, dir={skill_dir.name!r}); "
            "Pi will still load, but other Agent Skills harnesses may reject this."
        )


def _check_description(desc: str, errors: List[str], warnings: List[str]) -> None:
    if not desc:
        errors.append(
            "Missing required frontmatter field: description "
            "(Pi will not load the skill at all without this)"
        )
        return
    if len(desc) > MAX_DESCRIPTION:
        errors.append(f"description exceeds {MAX_DESCRIPTION} characters: {len(desc)}")
    if len(desc) < MIN_DESCRIPTION_LEN:
        warnings.append(
            f"description is only {len(desc)} chars; auto-trigger will be weak. "
            "Include both what the skill does and when to use it."
        )
    lower = desc.lower()
    trigger_hints = ("use when", "use to", "사용", "때", "할 때", "쓰", "면 ", "when ", "if you")
    if not any(h in lower for h in trigger_hints):
        warnings.append(
            "description does not appear to describe WHEN to trigger the skill. "
            "Include phrases like 'use when ...', '··할 때 사용', or trigger keywords."
        )


def _check_allowed_tools(value: object, warnings: List[str]) -> None:
    if not isinstance(value, str) or not value:
        return
    if "," in value:
        warnings.append(
            "allowed-tools should be space-delimited, not comma-delimited."
        )
    if value.startswith("[") and value.endswith("]"):
        warnings.append(
            "allowed-tools should be a plain space-delimited string, not a YAML list."
        )


def _check_body_references(
    body: str, skill_dir: Path, warnings: List[str]
) -> None:
    seen: set[str] = set()
    for match in RELPATH_RE.finditer(body):
        rel = match.group(1).rstrip(").,:;\"'")
        # Strip markdown fragment/query if any.
        rel_clean = rel.split("#", 1)[0].split("?", 1)[0]
        if rel_clean in seen:
            continue
        seen.add(rel_clean)
        target = (skill_dir / rel_clean).resolve()
        try:
            target.relative_to(skill_dir.resolve())
        except ValueError:
            warnings.append(f"relative path escapes skill directory: {rel_clean}")
            continue
        if not target.exists():
            warnings.append(f"referenced path does not exist: {rel_clean}")

    abs_hits: set[str] = set()
    for match in ABS_PATH_RE.finditer(body):
        hit = match.group(1)
        if hit in abs_hits:
            continue
        abs_hits.add(hit)
        warnings.append(
            f"body contains user-specific absolute path: {hit} "
            "(prefer ~ or skill-relative paths for portability)"
        )


def validate(path: Path) -> int:
    errors: List[str] = []
    warnings: List[str] = []
    infos: List[str] = []

    skill_dir = path.expanduser().resolve()
    if skill_dir.is_file():
        skill_file = skill_dir
        skill_dir = skill_file.parent
    else:
        skill_file = skill_dir / "SKILL.md"

    if not skill_file.exists():
        errors.append(f"Missing SKILL.md: {skill_file}")
        return report(skill_dir, errors, warnings, infos)

    text = skill_file.read_text(encoding="utf-8")
    frontmatter, fm_errors, fm_warnings = parse_frontmatter(text)
    errors.extend(fm_errors)
    warnings.extend(fm_warnings)

    name = str(frontmatter.get("name", "") or "")
    description = str(frontmatter.get("description", "") or "")
    compatibility = frontmatter.get("compatibility")
    allowed_tools = frontmatter.get("allowed-tools")

    _check_name(name, skill_dir, errors, warnings)
    _check_description(description, errors, warnings)
    _check_allowed_tools(allowed_tools, warnings)

    if isinstance(compatibility, str) and len(compatibility) > MAX_COMPATIBILITY:
        errors.append(
            f"compatibility exceeds {MAX_COMPATIBILITY} characters: {len(compatibility)}"
        )

    missing = REQUIRED_FIELDS - frontmatter.keys()
    for field in sorted(missing):
        if not any(field in e for e in errors):
            errors.append(f"Missing required frontmatter field: {field}")

    unknown = sorted(set(frontmatter.keys()) - KNOWN_FIELDS)
    for field in unknown:
        infos.append(
            f"frontmatter field '{field}' is not recognised by Pi and will be ignored "
            "(e.g. Claude Code's 'argument-hint')"
        )

    line_count = len(text.splitlines())
    if line_count > SOFT_LINE_LIMIT:
        warnings.append(
            f"SKILL.md is {line_count} lines; consider moving detail to references/"
        )

    # Body-only checks (skip frontmatter region and code blocks).
    body_start = 0
    parts = text.split("---", 2)
    if len(parts) >= 3:
        body_start = len(parts[0]) + len("---") + len(parts[1]) + len("---")
    body = text[body_start:]
    body_no_code = FENCED_CODE_RE.sub("", body)
    body_no_code = INLINE_CODE_RE.sub("", body_no_code)
    _check_body_references(body_no_code, skill_dir, warnings)

    for directory in ("scripts", "references", "assets"):
        candidate = skill_dir / directory
        if candidate.exists() and not candidate.is_dir():
            errors.append(f"{directory}/ exists but is not a directory")

    return report(skill_dir, errors, warnings, infos)


def report(
    skill_dir: Path,
    errors: List[str],
    warnings: List[str],
    infos: List[str] | None = None,
) -> int:
    print(f"Validating: {skill_dir}")
    if infos:
        print("\nInfo:")
        for info in infos:
            print(f"  - {info}")
    if warnings:
        print("\nWarnings:")
        for warning in warnings:
            print(f"  - {warning}")
    if errors:
        print("\nErrors:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("\nOK: skill passed validation checks")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a Pi/Agent Skills skill directory"
    )
    parser.add_argument("skill_path", help="Path to a skill directory or SKILL.md file")
    args = parser.parse_args()
    return validate(Path(args.skill_path))


if __name__ == "__main__":
    sys.exit(main())
