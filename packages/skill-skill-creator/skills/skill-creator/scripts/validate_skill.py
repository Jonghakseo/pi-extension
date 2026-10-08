#!/usr/bin/env python3
"""Validate a Pi/Agent Skills skill directory.

Runs on the standard library alone so the skill works without setup. PyYAML is
used when it happens to be installed; otherwise a built-in parser covers the
frontmatter shapes Pi accepts (quoted scalars, block scalars, nested mappings,
sequences).

Checks the constraints that break Pi skill loading, plus quality warnings
(short descriptions, broken skill-relative paths, absolute paths, unknown
frontmatter fields, etc.).

Exit codes:
  0  no errors (warnings allowed)
  1  at least one error
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

try:  # Optional: a real YAML parser matches Pi more closely than the fallback.
    import yaml as _yaml
except ImportError:  # pragma: no cover - exercised on hosts without PyYAML
    _yaml = None

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

# Agent Skills spec limits. Pi itself only emits a startup warning for these and
# still loads the skill; other harnesses are stricter, so treat them as errors.
MAX_DESCRIPTION = 1024
MAX_NAME = 64
MAX_COMPATIBILITY = 500

# Soft warnings.
MIN_DESCRIPTION_LEN = 15
SOFT_DESCRIPTION_MAX = 200
SOFT_LINE_LIMIT = 500

# Body references to bundled resources. Only file-looking paths are checked:
# bare `references/` or `scripts/...` are category mentions, not real targets.
# Inline code and fenced blocks are scanned too, since `` `references/x.md` ``
# is the most common way to point at a bundled file.
RELPATH_RE = re.compile(r"(?<![\w/])((?:scripts|references|assets)/[A-Za-z0-9_.-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+)")
FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
# Absolute paths that pin the skill to one machine/user.
ABS_PATH_RE = re.compile(r"(?<![\w`])(/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+)")

BLOCK_SCALAR_RE = re.compile(r"^([|>])([+-]?)(\d*)$")


class FrontmatterError(Exception):
    """Raised when the frontmatter block cannot be parsed at all."""


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _is_blank(line: str) -> bool:
    stripped = line.strip()
    return not stripped or stripped.startswith("#")


def _strip_inline_comment(text: str) -> str:
    """Drop a trailing `# comment`, which YAML only recognises after whitespace."""
    out: List[str] = []
    quote: str | None = None
    for index, char in enumerate(text):
        if quote:
            out.append(char)
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            out.append(char)
            continue
        if char == "#" and (index == 0 or text[index - 1] in " \t"):
            break
        out.append(char)
    return "".join(out).rstrip()


def _scalar(raw: str) -> Any:
    # Comments are stripped first; _strip_inline_comment ignores `#` inside quotes.
    text = _strip_inline_comment(raw.strip())
    if not text:
        return None
    if text[0] in "\"'" and len(text) >= 2 and text[-1] == text[0]:
        inner = text[1:-1]
        if text[0] == '"':
            return inner.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
        return inner.replace("''", "'")
    if text.startswith("[") and text.endswith("]"):
        body = text[1:-1].strip()
        return [_scalar(item) for item in body.split(",")] if body else []
    if text in ("true", "True", "yes", "on"):
        return True
    if text in ("false", "False", "no", "off"):
        return False
    if text in ("null", "Null", "~"):
        return None
    return text


def _read_block_scalar(lines: List[str], start: int, parent_indent: int, style: str, chomp: str) -> Tuple[str, int]:
    """Collect an indented `|` or `>` block and return (value, next_index)."""
    collected: List[str] = []
    index = start
    block_indent: int | None = None
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            collected.append("")
            index += 1
            continue
        indent = _indent_of(line)
        if indent <= parent_indent:
            break
        if block_indent is None:
            block_indent = indent
        collected.append(line[block_indent:] if len(line) > block_indent else "")
        index += 1

    while collected and collected[-1] == "":
        collected.pop()

    if style == "|":
        value = "\n".join(collected)
    else:
        # Folded: consecutive text lines join with a space, a blank line folds to a newline.
        value = ""
        buffer: List[str] = []
        for line in collected:
            if line.strip():
                buffer.append(line.strip())
                continue
            if buffer:
                value += (" " if value and not value.endswith("\n") else "") + " ".join(buffer)
                buffer = []
            value += "\n"
        if buffer:
            value += (" " if value and not value.endswith("\n") else "") + " ".join(buffer)

    if chomp != "-" and collected:
        value += "\n"
    return value, index


def _parse_block(lines: List[str], start: int, min_indent: int) -> Tuple[Any, int]:
    """Parse the nested mapping or sequence that begins at or after `start`.

    Sequence items are read as scalars; Pi's frontmatter fields never nest a
    mapping inside a sequence.
    """
    index = start
    while index < len(lines) and _is_blank(lines[index]):
        index += 1
    if index >= len(lines):
        return None, index
    actual = _indent_of(lines[index])
    if actual < min_indent:
        return None, index
    if lines[index].strip().startswith("-"):
        return _parse_sequence(lines, index, actual)
    return _parse_mapping(lines, index, actual)


def _parse_sequence(lines: List[str], start: int, indent: int) -> Tuple[List[Any], int]:
    items: List[Any] = []
    index = start
    while index < len(lines):
        line = lines[index]
        if _is_blank(line):
            index += 1
            continue
        if _indent_of(line) < indent:
            break
        stripped = line.strip()
        if not stripped.startswith("-"):
            break
        items.append(_scalar(stripped[1:]))
        index += 1
    return items, index


def _parse_mapping(lines: List[str], start: int, indent: int) -> Tuple[Dict[str, Any], int]:
    data: Dict[str, Any] = {}
    index = start
    while index < len(lines):
        line = lines[index]
        if _is_blank(line):
            index += 1
            continue
        current = _indent_of(line)
        if current < indent:
            break
        if current > indent:
            raise FrontmatterError(f"unexpected indentation in frontmatter: {line.strip()!r}")
        stripped = line.strip()
        if stripped.startswith("- "):
            break
        if ":" not in stripped:
            raise FrontmatterError(f"expected 'key: value' in frontmatter, found: {stripped!r}")
        key, _, rest = stripped.partition(":")
        key = key.strip().strip("\"'")
        rest = rest.strip()
        index += 1

        block = BLOCK_SCALAR_RE.match(rest)
        if block:
            value, index = _read_block_scalar(lines, index, current, block.group(1), block.group(2))
            data[key] = value
            continue
        if rest:
            data[key] = _scalar(rest)
            continue

        nested, next_index = _parse_block(lines, index, current + 1)
        data[key] = nested
        index = next_index
    return data, index


def _extract_frontmatter(text: str) -> str:
    """Return the raw YAML block, mirroring Pi's `--- ... ---` extraction."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    if not normalized.startswith("---"):
        raise FrontmatterError("SKILL.md must start with YAML frontmatter delimiter '---'")
    end = normalized.find("\n---", 3)
    if end == -1:
        raise FrontmatterError("SKILL.md frontmatter is missing closing '---'")
    return normalized[4:end]


def parse_frontmatter(text: str) -> Tuple[Dict[str, Any], List[str]]:
    """Parse SKILL.md frontmatter the way Pi's YAML parser would.

    Returns (frontmatter, errors). Pi refuses to load a SKILL.md whose
    frontmatter does not parse, so failures are errors rather than warnings.
    """
    try:
        yaml_text = _extract_frontmatter(text)
    except FrontmatterError as error:
        return {}, [str(error)]

    if _yaml is not None:
        try:
            parsed = _yaml.safe_load(yaml_text)
        except Exception as error:  # yaml.YAMLError and friends
            return {}, [f"frontmatter is not valid YAML: {error}"]
    else:
        try:
            parsed, _ = _parse_mapping(yaml_text.split("\n"), 0, 0)
        except FrontmatterError as error:
            return {}, [f"frontmatter is not valid YAML: {error}"]

    if parsed is None:
        return {}, []
    if not isinstance(parsed, dict):
        return {}, ["frontmatter must be a YAML mapping of key: value pairs"]
    return {str(key): value for key, value in parsed.items()}, []


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _check_name(name: str, skill_dir: Path, errors: List[str], warnings: List[str]) -> None:
    if not name:
        errors.append(
            "Missing required frontmatter field: name "
            "(Pi falls back to the directory name, but the Agent Skills standard requires it)"
        )
        return
    if len(name) > MAX_NAME:
        errors.append(f"name exceeds {MAX_NAME} characters: {len(name)}")
    if not NAME_RE.match(name):
        errors.append(
            "name must use lowercase letters, numbers, and single hyphens only "
            "(no leading/trailing or consecutive hyphens)"
        )
    if name != skill_dir.name:
        # Pi neither requires nor warns about this; the Agent Skills standard does.
        warnings.append(
            f"name does not match parent directory (name={name!r}, dir={skill_dir.name!r}); "
            "Pi will still load, but other Agent Skills harnesses may reject this."
        )


def _check_description(desc: str, errors: List[str], warnings: List[str]) -> None:
    if not desc.strip():
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
    if len(desc) > SOFT_DESCRIPTION_MAX:
        warnings.append(
            f"description is {len(desc)} chars; keep it to 1-2 sentences of purpose and "
            "trigger situation. Move implementation details, trigger phrase lists, and "
            "exclusions into the body."
        )
    lower = desc.lower()
    trigger_hints = ("use when", "use to", "사용", "때", "할 때", "쓰", "면 ", "when ", "if you")
    if not any(h in lower for h in trigger_hints):
        warnings.append(
            "description does not appear to describe WHEN to trigger the skill. "
            "Include phrases like 'use when ...', '··할 때 사용', or trigger keywords."
        )


def _check_allowed_tools(value: Any, warnings: List[str]) -> None:
    # Pi never reads allowed-tools; these checks are against the Agent Skills
    # spec, which defines the field as a space-separated string.
    if isinstance(value, list):
        warnings.append("allowed-tools should be a plain space-delimited string, not a YAML list.")
        return
    if not isinstance(value, str) or not value:
        return
    if "," in value:
        warnings.append("allowed-tools should be space-delimited, not comma-delimited.")
    if value.startswith("[") and value.endswith("]"):
        warnings.append("allowed-tools should be a plain space-delimited string, not a YAML list.")


def _check_body_references(body: str, body_without_code: str, skill_dir: Path, warnings: List[str]) -> None:
    seen: set[str] = set()
    for match in RELPATH_RE.finditer(body):
        rel = match.group(1).rstrip(").,:;\"'")
        rel_clean = rel.split("#", 1)[0].split("?", 1)[0]
        if not rel_clean or rel_clean in seen:
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
    for match in ABS_PATH_RE.finditer(body_without_code):
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
    frontmatter, fm_errors = parse_frontmatter(text)
    errors.extend(fm_errors)

    name = _as_text(frontmatter.get("name"))
    description = _as_text(frontmatter.get("description"))
    compatibility = frontmatter.get("compatibility")

    _check_name(name, skill_dir, errors, warnings)
    _check_description(description, errors, warnings)
    if "allowed-tools" in frontmatter:
        _check_allowed_tools(frontmatter["allowed-tools"], warnings)

    if compatibility is not None and len(_as_text(compatibility)) > MAX_COMPATIBILITY:
        errors.append(
            f"compatibility exceeds {MAX_COMPATIBILITY} characters: {len(_as_text(compatibility))}"
        )

    if frontmatter:
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

    # Body-only checks: skip the frontmatter region.
    body_start = 0
    parts = text.split("---", 2)
    if len(parts) >= 3:
        body_start = len(parts[0]) + len("---") + len(parts[1]) + len("---")
    body = text[body_start:]
    body_without_code = INLINE_CODE_RE.sub("", FENCED_CODE_RE.sub("", body))
    _check_body_references(body, body_without_code, skill_dir, warnings)

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
    if warnings:
        print(f"\nOK with warnings ({len(warnings)}): no blocking errors, review the warnings above")
        return 0
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
