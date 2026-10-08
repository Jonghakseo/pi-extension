#!/usr/bin/env python3
"""Regression tests for scripts/validate_skill.py.

Run: python3 tests/test_validate_skill.py
"""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True  # keep __pycache__ out of the published skill directory
sys.path.insert(0, str(PACKAGE_ROOT / "skills" / "skill-creator" / "scripts"))

import validate_skill  # noqa: E402


def write_skill(root: Path, name: str, skill_md: str, extra: dict[str, str] | None = None) -> Path:
    skill_dir = root / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(skill_md, encoding="utf-8")
    for rel, content in (extra or {}).items():
        target = skill_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return skill_dir


def run_validate(skill_dir: Path) -> tuple[int, str]:
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        code = validate_skill.validate(skill_dir)
    return code, buffer.getvalue()


class FrontmatterParsing(unittest.TestCase):
    def test_block_scalar_description_keeps_its_full_text(self):
        front, errors = validate_skill.parse_frontmatter(
            "---\nname: multiline\ndescription: >\n  여러 줄 설명을\n  쓸 때 사용한다.\n---\nbody\n"
        )
        self.assertEqual(errors, [])
        self.assertEqual(front["description"], "여러 줄 설명을 쓸 때 사용한다.\n")

    def test_literal_block_scalar_keeps_newlines(self):
        front, _ = validate_skill.parse_frontmatter("---\ndescription: |\n  first\n  second\n---\nbody\n")
        self.assertEqual(front["description"], "first\nsecond\n")

    def test_literal_block_scalar_strip_chomping(self):
        front, _ = validate_skill.parse_frontmatter("---\ndescription: |-\n  only\n---\nbody\n")
        self.assertEqual(front["description"], "only")

    def test_nested_mapping_parses_as_an_object(self):
        front, errors = validate_skill.parse_frontmatter(
            '---\nname: meta\ndescription: 설명을 쓸 때 사용한다.\nmetadata:\n  author: ryan\n  version: "1"\n---\nbody\n'
        )
        self.assertEqual(errors, [])
        self.assertEqual(front["metadata"], {"author": "ryan", "version": "1"})

    def test_booleans_quotes_and_comments(self):
        front, _ = validate_skill.parse_frontmatter(
            "---\n"
            "disable-model-invocation: true\n"
            "# a comment line\n"
            'name: "quoted-name"  # trailing comment\n'
            "license: MIT\n"
            "---\nbody\n"
        )
        self.assertIs(front["disable-model-invocation"], True)
        self.assertEqual(front["name"], "quoted-name")
        self.assertEqual(front["license"], "MIT")

    def test_missing_delimiters_are_errors(self):
        self.assertTrue(validate_skill.parse_frontmatter("no frontmatter\n")[1])
        self.assertTrue(validate_skill.parse_frontmatter("---\nname: x\n")[1])


class Validation(unittest.TestCase):
    def test_block_scalar_description_over_the_limit_still_fails(self):
        # Regression: the old line-based parser read the value as "|" and reported
        # "description is only 1 chars" with exit 0.
        long_text = "가" * 1200
        with tempfile.TemporaryDirectory() as tmp:
            skill = write_skill(
                Path(tmp),
                "too-long",
                f"---\nname: too-long\ndescription: |-\n  {long_text}\n---\n\n# too-long\n",
            )
            code, output = run_validate(skill)
        self.assertEqual(code, 1)
        self.assertIn("description exceeds 1024 characters: 1200", output)

    def test_nested_metadata_does_not_produce_warnings(self):
        with tempfile.TemporaryDirectory() as tmp:
            skill = write_skill(
                Path(tmp),
                "meta-skill",
                "---\nname: meta-skill\ndescription: 메타데이터를 확인할 때 사용한다.\n"
                'metadata:\n  author: ryan\n  version: "1"\n---\n\n# meta-skill\n',
            )
            code, output = run_validate(skill)
        self.assertEqual(code, 0)
        self.assertNotIn("Warnings:", output)
        self.assertNotIn("Info:", output)

    def test_backticked_missing_reference_is_reported(self):
        # Regression: inline code used to be stripped before the path check, so the
        # most common way of citing a bundled file was never validated.
        with tempfile.TemporaryDirectory() as tmp:
            skill = write_skill(
                Path(tmp),
                "refs",
                "---\nname: refs\ndescription: 참조를 확인할 때 사용한다.\n---\n\n"
                "# refs\n\n자세한 내용은 `references/missing.md`를 읽는다.\n",
            )
            code, output = run_validate(skill)
        self.assertEqual(code, 0)
        self.assertIn("referenced path does not exist: references/missing.md", output)

    def test_existing_references_and_category_mentions_stay_quiet(self):
        with tempfile.TemporaryDirectory() as tmp:
            skill = write_skill(
                Path(tmp),
                "refs-ok",
                "---\nname: refs-ok\ndescription: 참조를 확인할 때 사용한다.\n---\n\n"
                "# refs-ok\n\n긴 자료는 `references/`에, 템플릿은 `assets/`에 둔다.\n"
                "`references/setup.md`와 [설정](references/setup.md)을 읽는다.\n"
                "```bash\npython3 scripts/run.py\n```\n",
                extra={"references/setup.md": "setup\n", "scripts/run.py": "print(1)\n"},
            )
            code, output = run_validate(skill)
        self.assertEqual(code, 0)
        self.assertNotIn("Warnings:", output)

    def test_missing_name_mentions_the_pi_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            skill = write_skill(
                Path(tmp), "no-name", "---\ndescription: 이름이 없을 때 사용한다.\n---\n\n# no-name\n"
            )
            code, output = run_validate(skill)
        self.assertEqual(code, 1)
        self.assertIn("Pi falls back to the directory name", output)

    def test_warning_count_is_visible_in_the_success_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            skill = write_skill(
                Path(tmp),
                "warned",
                "---\nname: other-name\ndescription: 경고를 확인할 때 사용한다.\n---\n\n# warned\n",
            )
            code, output = run_validate(skill)
        self.assertEqual(code, 0)
        self.assertIn("OK with warnings (1)", output)

    def test_clean_skill_reports_plain_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            skill = write_skill(
                Path(tmp), "clean", "---\nname: clean\ndescription: 깨끗한 스킬을 확인할 때 사용한다.\n---\n\n# clean\n"
            )
            code, output = run_validate(skill)
        self.assertEqual(code, 0)
        self.assertIn("OK: skill passed validation checks", output)

    def test_absolute_user_paths_outside_code_are_flagged(self):
        with tempfile.TemporaryDirectory() as tmp:
            skill = write_skill(
                Path(tmp),
                "abs",
                "---\nname: abs\ndescription: 절대 경로를 확인할 때 사용한다.\n---\n\n"
                "# abs\n\n/Users/someone/notes.md 를 연다.\n",
            )
            code, output = run_validate(skill)
        self.assertEqual(code, 0)
        self.assertIn("user-specific absolute path: /Users/someone", output)

    def test_broken_frontmatter_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            skill = write_skill(Path(tmp), "broken", "---\nname skill\n---\n\n# broken\n")
            code, output = run_validate(skill)
        self.assertEqual(code, 1)
        self.assertIn("not valid YAML", output)


class BundledSkills(unittest.TestCase):
    def test_every_skill_in_this_repo_validates_without_errors(self):
        repo_root = PACKAGE_ROOT.parents[1]
        skills = sorted(repo_root.glob("packages/*/skills/*/SKILL.md")) + sorted(
            repo_root.glob("packages/*/seeds/skills/*/SKILL.md")
        )
        self.assertGreater(len(skills), 0, "no bundled SKILL.md found")
        for skill_md in skills:
            with self.subTest(skill=str(skill_md.relative_to(repo_root))):
                code, output = run_validate(skill_md.parent)
                self.assertEqual(code, 0, output)
                self.assertNotIn("referenced path does not exist", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
