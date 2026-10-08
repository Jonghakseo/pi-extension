---
name: a4
description: Markdown 문서를 A4 인쇄용 Word(.docx)로 변환할 때 사용한다.
license: MIT (see LICENSE)
compatibility: macOS + Microsoft Word 기준으로 검증했다. Requires python3 with python-docx. The default style profile expects the Noto Sans CJK KR font; the optional HTML converter needs Node and the bundled markdown-it.
---

# A4 Markdown to Microsoft Word DOCX

## Purpose

Create a print-ready A4 Microsoft Word `.docx` from Markdown. Preserve the source content exactly in meaning, order, heading hierarchy, lists, tables, blockquotes, and code blocks.

Do **not** summarize, rewrite, translate, add claims, remove sections, reorder sections, or change legal/business wording. This skill is for layout and DOCX conversion only.

## Setup

`<skill-dir>` is the directory containing this `SKILL.md`. Always run the bundled scripts through `python3` (or `node` for the `.mjs` one) with an absolute path built from the skill directory, not the current working directory. Installed copies have no execute bit, so calling a script path directly fails with `Permission denied`.

The DOCX scripts need `python3` and the `python-docx` library. Before the first conversion, run `python3 -c "import docx"`. If it fails, follow [references/setup.md](references/setup.md) and tell the user the one-time install command instead of guessing another method.

Tell the user what is missing instead of silently working around it:

| Symptom | What to tell the user |
| --- | --- |
| `Missing dependency: python-docx` (exit 2) | Give the one-time command `python3 -m pip install --user python-docx`, and mention that Homebrew Python may need `--break-system-packages` (see [references/setup.md](references/setup.md)). |
| `Permission denied` on a script path | Re-run the same command prefixed with `python3` or `node`. Do not `chmod` files inside an installed package. |
| `Input ... not found` (exit 2) | Confirm the path with the user; do not guess a nearby file. |
| Default profile requested but Noto Sans CJK KR is missing | Say that Word will substitute another face, and offer `brew install --cask font-noto-sans-cjk-kr` or a different font choice. |
| Requested custom font is not installed | Report it and stop. Never substitute a different face silently. |

## Output rule

- Default output is **DOCX**, not HTML.
- If the user says `/skill:a4 input.md` without an output path, write `input.a4.docx` next to the input file.
- If the user casually says `.doc`, still generate `.docx` unless they explicitly require legacy binary `.doc`.
- Do not use the HTML converter unless the user explicitly asks for HTML. When they do, run `node <skill-dir>/scripts/md-to-a4-html.mjs input.md -o output.html`. It prints a source SHA-256 and a heading-count check; there is no DOCX-style full-text checker for HTML.

## Workflow

1. Read the Markdown source and any visual reference.
2. Treat references as style examples only unless exact reproduction is explicitly requested.
3. Convert:

```bash
python3 <skill-dir>/scripts/md-to-a4-docx.py input.md -o output.docx
```

If no output path is needed:

```bash
python3 <skill-dir>/scripts/md-to-a4-docx.py input.md
```

Useful converter options: `--title` sets only the DOCX core-properties title (visible content is untouched), `--accent` overrides the accent color hex (default `#1f4e79`), and `--no-cover` drops the extra spacing after the first H1.

4. Verify with the bundled checker:

```bash
python3 <skill-dir>/scripts/check-a4-docx.py output.docx input.md
```

5. For custom font, weight or size requests, apply the custom typography workflow below. Then perform the visual verification below. Do not rely only on HTML previews.
6. Report input path, output path, heading check, table count, footer PAGE check, and whether wording was edited. Usually wording should be “not edited”.

## Style profile

Use a restrained Korean business document style:

- A4 page size.
- Margins: top 3.0cm, bottom/left/right 2.54cm.
- Font: **Noto Sans CJK KR** for body, headings, tables, lists, Latin slots, and East Asian slots. Fenced code blocks and inline code are the one exception, and use Courier New.
- Noto Sans CJK KR is not bundled with macOS. Check it with `system_profiler SPFontsDataType | grep -i "Noto Sans CJK KR"` before promising the default look; if missing, say so (see [references/setup.md](references/setup.md)) because Word silently falls back to another face.
- Body text around 10pt.
- H1 around 18pt bold.
- H2 around 12pt bold.
- H3 around 10.5pt bold.
- White page, black text, restrained bold headings, simple spacing, minimal color.
- No decorative cover page, heavy shadows, glassmorphism, arbitrary illustrations, or ornamental effects.
- Current page number appears in the bottom-right footer.

## Readability spacing rules

Junior implementer rule of thumb: **use paragraph spacing for readability, not loose line spacing.**

- Base line spacing is exactly **1.0**.
- H2 headings have clear space before them.
- H3 headings have moderate space before them.
- Normal prose has a small after-space.
- Lists have compact after-space.
- Do not use 1.15 or 1.25 line spacing unless the user explicitly asks.

## Markdown handling rules

### Headings

- Preserve heading levels.
- Headings must use Word heading styles.
- Headings must not use bullet/list styles or Word numbering.
- Remove Word `keepNext` and `keepLines` flags so black square formatting marks do not appear beside headings.

### Lists

- Markdown unordered lists (`- item`) become real Word bullet lists.
- Markdown ordered lists (`1. item`) render as plain source numbers, not Word automatic numbering. This allows numbering to restart exactly as written.
- The generated `word/document.xml` should not contain unintended `<w:numPr>` numbering entries.

### Tables

- Markdown pipe tables must become real Word tables.
- Do not flatten tables into paragraphs.
- Use clean Word table styling and stable fixed widths when needed so Korean/CJK text does not break badly in Word/PDF export.
- If the Markdown source uses `<br>` inside a table cell, the final DOCX/PDF must show an actual line break, not the literal text `<br>`.

Example source:

```md
| 구분 | 기간 |
| --- | --- |
| 개발<br>QA | 20영업일<br>5영업일 |
```

Correct final cell display:

```text
개발
QA
```

Wrong final output:

```text
개발<br>QA
```

If literal `<br>` appears in Word/PDF, conversion failed. Fix before reporting completion.

## Fidelity rules

- Preserve all source text and section order.
- Preserve heading levels instead of visually flattening them.
- Preserve bilingual or parallel-language structure if it already exists in the source.
- Do not “improve” wording, punctuation, honorifics, numbers, percentages, dates, names, or contract terms.
- Layout-only transformations are allowed: A4 page size, margins, typography, table styling, page number, and spacing.
- If Markdown is malformed, report the ambiguity instead of silently rewriting content.

## Verification checklist

Before saying complete:

- Source Markdown heading count matches DOCX heading count. Fenced-code examples are excluded from heading/table counts but retained in full text comparison.
- Source Markdown table count matches real DOCX table count.
- Full visible body text matches in document order, including table cells and contract blanks. Both source-aware checkers print `Full ordered text: OK`; only whitespace differences are ignored.
- DOCX zip integrity is OK.
- Bottom-right footer contains a `PAGE` field.
- Base line spacing overrides are 1.0.
- No visible literal `<br>` / `&lt;br&gt;` text appears in DOCX output.
- No unintended Word automatic numbering (`w:numPr`).
- No `w:keepNext` or `w:keepLines` entries.
- Key numbers, dates, names, and percentages are still present.
- For legal/proposal documents, explicitly state that wording was not edited.

## Custom typography workflow

User-specified fonts and sizes override the default style profile. If `python-docx` is missing, use the install steps in [references/setup.md](references/setup.md). Resolve script paths relative to this skill directory.

1. Confirm the exact named faces are installed. On macOS use `system_profiler SPFontsDataType | grep -i pretendard`; `fc-list | grep -i pretendard` works only when fontconfig is installed (`brew install fontconfig`), which macOS does not ship by default. XML names alone do not prove Word can render the font. If unavailable, report it rather than silently substituting.
2. Run the base converter and `check-a4-docx.py` first.
3. Apply named faces with the bundled postprocessor. Preserve the original DOCX by choosing a different output path.

```bash
python3 <skill-dir>/scripts/apply-docx-typography.py base.docx -o final.docx \
  --regular-face "Pretendard" \
  --medium-face "Pretendard Medium" \
  --semibold-face "Pretendard SemiBold" \
  --body-size 10.5 --section-size 12 --title-size 16 \
  --monochrome
python3 <skill-dir>/scripts/check-a4-docx.py final.docx source.md
python3 <skill-dir>/scripts/check-docx-typography.py final.docx \
  --fonts "Pretendard|Pretendard Medium|Pretendard SemiBold" \
  --sizes "10.5,12,16" --min-size 10.5 --no-bold --exact-sizes \
  --source source.md
```

- H1 uses SemiBold/title size; H2 uses SemiBold/section size; H3–H6 use Medium/body size.
- Ordinary paragraphs, lists, table bodies and footers use Regular/body size. Table first rows use Medium/body size. Existing directly bold inline runs use SemiBold at body size; heading size takes priority within headings.
- Named faces encode weight. Do not use `Pretendard` plus `bold=True`: Word may select Pretendard Bold rather than the requested SemiBold. Set `b` and `bCs` false.
- Apply all four Latin/CJK/complex-script font slots, styles, direct runs, tables, headers, footers and other `word/*.xml` parts, including dormant formatting. Remove font theme overrides.
- The body minimum applies to tables, code, footnotes and footers too. Choose at most three sizes. Repeated size values are valid; omit `--exact-sizes` when only an allowed subset is required. OOXML sizes must be multiples of 0.5pt.
- The postprocessor removes automatic numbering properties and keepNext/keepLines everywhere. Use the base converter's source-numbered ordered lists; do not use this mode to preserve arbitrary Word automatic-numbering documents.
- `--monochrome` sets text black and cell shading white; omit it to retain colors. This is not image recoloring.
- Preserve real tables, repeating first rows and unsplittable rows. Prefer fixed widths in the base layout. Never shrink text below the requested minimum to fit a table: accept extra pages and adjust widths instead. A row taller than a page needs manual layout review.

## Visual verification and macOS permissions

For design requirements, open the final file in Microsoft Word and inspect the actual rendering. When possible, export a PDF through Word and inspect every page, including clipping, table width, page breaks, and page numbers.

- Export PDF beside the DOCX or into a user-approved folder. Word's sandbox may show a `파일 액세스 부여` dialog for `/tmp`.
- If permission is blocked, stop retrying and cancel the Word dialog so Word is not left stalled. Do not manipulate permission dialogs belonging to other apps, including Picky.
- If PDF export remains blocked, capture the actual Word window and inspect the first page, densest table and final signature page. Report that PDF/all-page inspection was unavailable; selected screenshots do not prove every page is correct.
- Do not close unrelated documents or claim screen verification from automation summaries alone.
- Remove only the temporary files or hidden preview directories created for this validation. Keep the final deliverable and source.

## Final validation order

1. Run `check-a4-docx.py` against the final DOCX and Markdown. It checks heading/table counts and full ordered visible text, excluding footer fields. A mismatch reports the first differing character and surrounding text.
2. In custom typography mode, run `check-docx-typography.py` against the actual ZIP/XML. It checks CT_Style, CT_RPr and CT_PPr known-property child order across all Word XML parts, font slots/themes, size sets, minimum size, bold flags, PAGE footer field, spacing, forbidden numbering/keep flags and table pagination. `--source` reuses the base checker for full ordered text comparison as well as heading/table counts.
3. Directly compare key wording, names, dates, amounts and percentages to the source. Count checks alone cannot prove content fidelity.
4. Inspect Word/PDF as above.
5. Report output path, heading/table counts, footer PAGE result, actual font/size sets, wording-change status and any unperformed visual checks. Never claim unchanged wording without checking the content.

## Failure patterns to avoid

- Contract blanks such as `__________` can be mistaken for underscore emphasis and lose characters. Keep delimiter boundaries strict, parse inline syntax only once, and compare full ordered text rather than trusting counts.
- Default converter table text at 8–9pt violates a user's body minimum.
- Editing styles alone leaves old direct-run, table and footer fonts intact.
- Preserve OOXML CT_Style child order when inserting paragraph/run properties. Character styles must not acquire paragraph properties.
- Normalize paragraph `pPr/spacing` only; run `rPr/spacing` controls character spacing and must remain unchanged.
- `Pretendard` plus synthetic bold selects an unrequested weight.
- Repeated `/tmp` PDF exports trap Word behind a file-access dialog.
- Trusting an automation summary without inspecting actual DOCX XML and Word pixels misses rendering failures.

## Skill regression checks

The bundled harness covers this automatically, but it ships only in the git checkout. `package.json` excludes `skills/a4/scripts/test-*.py` from the published package, so an installed copy has no test file.

```bash
python3 <repo>/packages/skill-a4/skills/a4/scripts/test-a4-regressions.py [contract.md]
```

It prints eight `PASS` lines and exits 0. The optional argument runs the same pipeline against a real contract Markdown. The harness builds everything in a system temp directory, so the repo stays clean.

Without the checkout, reproduce manually: a normal Markdown conversion, a Pretendard three-weight/three-size contract, and a document requesting one shared size. Verify the restricted checker rejects a disallowed font or enabled bold flag. Use a sibling workspace for generated test files and remove that workspace after validation; never overwrite the real contract.
