#!/usr/bin/env python3
"""Convert Markdown to an A4-styled DOCX while preserving document order/content.

This intentionally supports the Markdown constructs commonly used in business/legal
source files: headings, paragraphs, blockquotes, unordered/ordered lists, pipe
tables, horizontal rules, fenced code blocks, inline emphasis, hard line breaks,
and raw <br> in table cells.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import re
import sys
import tempfile
import zipfile
from pathlib import Path

from markdown_structure import outside_code_fences

try:
    from docx import Document
    from docx.enum.section import WD_SECTION_START
    from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Cm, Pt, RGBColor
except Exception as exc:  # pragma: no cover - user-facing dependency guard
    print("Missing dependency: python-docx", file=sys.stderr)
    print("Install once with: python3 -m pip install python-docx", file=sys.stderr)
    print(f"Original error: {exc}", file=sys.stderr)
    sys.exit(2)

ACCENT = "1F4E79"
INK = "1F2933"
MUTED = "667085"
LINE = "D9DEE7"
TABLE_HEADER = "F2F5F9"
QUOTE_BG = "F7F9FC"
FONT = "Noto Sans CJK KR"
CJK_FONT = "Noto Sans CJK KR"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert Markdown to A4 DOCX without rewriting source text.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("input", help="Input Markdown path")
    parser.add_argument("-o", "--output", help="Output DOCX path (default: input basename + .a4.docx)")
    parser.add_argument("--title", help="Core properties title only; visible content is not changed")
    parser.add_argument("--accent", default=f"#{ACCENT}", help="Accent color hex (default: #1f4e79)")
    parser.add_argument("--no-cover", action="store_true", help="Do not add extra spacing after the first H1")
    args = parser.parse_args()
    if not args.output:
        p = Path(args.input)
        args.output = str(p.with_name(f"{p.stem}.a4.docx"))
    return args


def normalize_hex(color: str) -> str:
    color = color.strip().lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{6}", color):
        return color.upper()
    return ACCENT


def count_markdown_headings(markdown: str) -> dict[str, int]:
    counts = {f"h{i}": 0 for i in range(1, 7)}
    for m in re.finditer(r"^(#{1,6})\s+\S.*$", outside_code_fences(markdown), flags=re.M):
        counts[f"h{len(m.group(1))}"] += 1
    return counts


def count_docx_headings(doc: Document) -> dict[str, int]:
    counts = {f"h{i}": 0 for i in range(1, 7)}
    for p in doc.paragraphs:
        name = p.style.name if p.style is not None else ""
        m = re.fullmatch(r"Heading ([1-6])", name)
        if m:
            counts[f"h{m.group(1)}"] += 1
    return counts


def strip_markdown_heading(line: str) -> tuple[int, str] | None:
    m = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
    if not m:
        return None
    return len(m.group(1)), m.group(2)


def is_table_separator(line: str) -> bool:
    s = line.strip()
    if "|" not in s:
        return False
    s = s.strip("|").strip()
    if not s:
        return False
    return all(re.fullmatch(r":?-{3,}:?", part.strip()) for part in s.split("|"))


def is_table_row(line: str) -> bool:
    return "|" in line and line.strip().startswith("|") and line.strip().endswith("|")


def split_table_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


# Underscore delimiters must be isolated and touch non-whitespace content.
# In particular, never pair the ends of two contract blank placeholders.
UNDERSCORE_BOLD = r"(?<![\w_])__[^_\s](?:[^_]*?[^_\s])?__(?![\w_])"
UNDERSCORE_ITALIC = r"(?<![\w_])_[^_\s](?:[^_]*?[^_\s])?_(?![\w_])"


def clean_visible_text(text: str) -> str:
    """Remove inline syntax using exactly the renderer's delimiter rules."""
    return "".join("\n" if kind == "break" else value
                   for kind, value in iter_inline_segments(text)).rstrip()


def iter_inline_segments(text: str):
    """Yield (kind, value) where kind is normal/bold/italic/code/break."""
    text = text.replace("<br />", "\n").replace("<br/>", "\n").replace("<br>", "\n")
    token = re.compile(
        r"\n|`[^`]+`|\*\*[^*]+\*\*|" + UNDERSCORE_BOLD
        + r"|(?<!\*)\*[^*]+\*(?!\*)|" + UNDERSCORE_ITALIC
        + r"|\[[^\]]+\]\([^)]+\)"
    )
    pos = 0
    for m in token.finditer(text):
        if m.start() > pos:
            yield "normal", html.unescape(text[pos:m.start()])
        raw = m.group(0)
        if raw == "\n":
            yield "break", ""
        elif raw.startswith("`"):
            yield "code", html.unescape(raw[1:-1])
        elif raw.startswith("**") or raw.startswith("__"):
            yield "bold", html.unescape(raw[2:-2])
        elif raw.startswith("*") or raw.startswith("_"):
            yield "italic", html.unescape(raw[1:-1])
        elif raw.startswith("["):
            lm = re.match(r"\[([^\]]+)\]\(([^)]+)\)", raw)
            yield "normal", html.unescape(lm.group(1) if lm else raw)
        pos = m.end()
    if pos < len(text):
        yield "normal", html.unescape(text[pos:])


def apply_font_slots(rpr, latin_font: str = FONT, east_asia_font: str = CJK_FONT):
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    rfonts.set(qn("w:ascii"), latin_font)
    rfonts.set(qn("w:hAnsi"), latin_font)
    rfonts.set(qn("w:eastAsia"), east_asia_font)
    rfonts.set(qn("w:cs"), latin_font)


def set_run_font(run, size_pt: float | None = None, color: str | None = None, bold: bool | None = None, italic: bool | None = None):
    run.font.name = FONT
    apply_font_slots(run._element.get_or_add_rPr())
    if size_pt is not None:
        run.font.size = Pt(size_pt)
    if color:
        run.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic


def add_inline(paragraph, text: str, size_pt: float | None = None, color: str | None = None):
    for kind, value in iter_inline_segments(text):
        if kind == "break":
            paragraph.add_run().add_break(WD_BREAK.LINE)
            continue
        run = paragraph.add_run(value)
        set_run_font(
            run,
            size_pt=size_pt,
            color=color,
            bold=True if kind == "bold" else None,
            italic=True if kind == "italic" else None,
        )
        if kind == "code":
            run.font.name = "Courier New"
            apply_font_slots(run._element.get_or_add_rPr(), "Courier New", "Courier New")


def set_paragraph_spacing(p, before=0, after=0, line=1.0):
    p.paragraph_format.space_before = Pt(before)
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.line_spacing = line


def set_cell_shading(cell, fill: str):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), fill)
    tc_pr.append(shd)


def set_cell_text(cell, text: str, bold=False, size=9.2):
    cell.text = ""
    parts = text.split("\n")
    p = cell.paragraphs[0]
    set_paragraph_spacing(p, after=0, line=1.15)
    for idx, part in enumerate(parts):
        if idx:
            p.add_run().add_break(WD_BREAK.LINE)
        add_inline(p, part, size_pt=size)
    for run in p.runs:
        if bold:
            run.bold = True
        set_run_font(run, size_pt=size, bold=bold if bold else run.bold)
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP


def style_document(doc: Document, accent: str):
    sec = doc.sections[0]
    sec.page_width = Cm(21.0)
    sec.page_height = Cm(29.7)
    # Reference proposal profile: Word A4 default-like margins.
    sec.top_margin = Cm(3.0)
    sec.bottom_margin = Cm(2.54)
    sec.left_margin = Cm(2.54)
    sec.right_margin = Cm(2.54)

    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = FONT
    normal_rpr = normal._element.get_or_add_rPr()
    apply_font_slots(normal_rpr)
    normal.font.size = Pt(10)
    normal.font.color.rgb = RGBColor.from_string(INK)

    # Match the reference proposal's restrained Word-document feel:
    # H1 18pt bold, H2 12pt bold, H3 10.5pt bold, no accent coloring.
    for level, size in [(1, 18), (2, 12), (3, 10.5), (4, 10.5), (5, 10), (6, 10)]:
        st = styles[f"Heading {level}"]
        st.font.name = FONT
        st_rpr = st._element.get_or_add_rPr()
        apply_font_slots(st_rpr)
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.color.rgb = RGBColor.from_string("000000")
        # Do not set keep-with-next/keep-lines on headings. In Word's
        # formatting-mark view those options appear as black square marks,
        # which look like unwanted bullets beside titles.
        st.paragraph_format.keep_with_next = None
        st.paragraph_format.keep_together = None
        st.paragraph_format.space_before = Pt(0)
        st.paragraph_format.space_after = Pt(0)
        st.paragraph_format.line_spacing = 1.0


def add_horizontal_rule(doc: Document):
    p = doc.add_paragraph()
    p_pr = p._p.get_or_add_pPr()
    p_bdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), LINE)
    p_bdr.append(bottom)
    p_pr.append(p_bdr)
    set_paragraph_spacing(p, before=0, after=0)


def add_paragraph_with_text(doc: Document, text: str, style=None, quote=False):
    p = doc.add_paragraph(style=style)
    set_paragraph_spacing(p, after=0, line=1.0)
    if quote:
        p.paragraph_format.left_indent = Cm(0.35)
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
    add_inline(p, text)
    return p


def parse_markdown_to_docx(markdown: str, doc: Document, accent: str, cover: bool):
    lines = markdown.splitlines()
    i = 0
    first_h1 = True
    in_code = False
    code_lines: list[str] = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):
            if not in_code:
                in_code = True
                code_lines = []
            else:
                p = doc.add_paragraph()
                set_paragraph_spacing(p, before=0, after=0, line=1.0)
                run = p.add_run("\n".join(code_lines))
                set_run_font(run, size_pt=9.2, color="111827")
                run.font.name = "Courier New"
                apply_font_slots(run._element.get_or_add_rPr(), "Courier New", "Courier New")
                in_code = False
            i += 1
            continue
        if in_code:
            code_lines.append(line)
            i += 1
            continue

        if not stripped:
            i += 1
            continue

        heading = strip_markdown_heading(line)
        if heading:
            level, text = heading
            p = doc.add_paragraph(style=f"Heading {level}")
            add_inline(p, text)
            if level == 1 and first_h1 and cover:
                p.paragraph_format.space_after = Pt(0)
                first_h1 = False
            i += 1
            continue

        if re.fullmatch(r"-{3,}|_{3,}|\*{3,}", stripped):
            add_horizontal_rule(doc)
            i += 1
            continue

        if is_table_row(line) and i + 1 < len(lines) and is_table_separator(lines[i + 1]):
            header = split_table_row(line)
            i += 2
            rows = []
            while i < len(lines) and is_table_row(lines[i]):
                rows.append(split_table_row(lines[i]))
                i += 1
            table = doc.add_table(rows=1 + len(rows), cols=len(header))
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            try:
                table.style = "Plain Table 2"
            except Exception:
                table.style = "Table Grid"
            for c, text in enumerate(header):
                set_cell_shading(table.cell(0, c), TABLE_HEADER)
                set_cell_text(table.cell(0, c), text, bold=True, size=9.2)
            for r, row in enumerate(rows, start=1):
                for c in range(len(header)):
                    set_cell_text(table.cell(r, c), row[c] if c < len(row) else "", size=9.2)
            doc.add_paragraph()
            continue

        bullet = re.match(r"^(\s*)[-*+]\s+(.+)$", line)
        ordered = re.match(r"^(\s*)(\d+[.)])\s+(.+)$", line)
        if bullet or ordered:
            m = bullet or ordered
            indent_spaces = len(m.group(1))
            marker = "" if bullet else m.group(2)
            text = (m.group(2) if bullet else m.group(3)).rstrip()
            # Markdown continuation lines, e.g. Korean line + indented Chinese line.
            while i + 1 < len(lines) and lines[i + 1].startswith(" " * (indent_spaces + 2)) and lines[i + 1].strip() and not lines[i + 1].lstrip().startswith(("- ", "* ", "+ ")):
                nxt = lines[i + 1].strip()
                if re.match(r"\d+[.)]\s+", nxt):
                    break
                text += "\n" + nxt
                i += 1
            if bullet:
                # Real Markdown unordered lists should remain visible bullet lists.
                p = doc.add_paragraph(style="List Bullet")
                level = max(0, indent_spaces // 2)
                p.paragraph_format.left_indent = Cm(0.55 + level * 0.45)
                p.paragraph_format.first_line_indent = Cm(-0.2)
                visible = text
            else:
                # Ordered lists are rendered as plain source numbers, not Word auto-numbering,
                # so numbering restarts exactly as written in each section/clause.
                p = doc.add_paragraph()
                if indent_spaces:
                    p.paragraph_format.left_indent = Cm((indent_spaces // 2) * 0.45)
                visible = f"{marker} {text}"
            set_paragraph_spacing(p, after=0, line=1.0)
            add_inline(p, visible)
            i += 1
            continue

        if stripped.startswith(">"):
            quote_lines = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote_lines.append(lines[i].strip().lstrip(">").strip())
                i += 1
            add_paragraph_with_text(doc, "\n".join(quote_lines), quote=True)
            continue

        para_lines = [line.rstrip()]
        while i + 1 < len(lines):
            nxt = lines[i + 1]
            nstr = nxt.strip()
            if not nstr:
                break
            if strip_markdown_heading(nxt) or re.fullmatch(r"-{3,}|_{3,}|\*{3,}", nstr):
                break
            if nstr.startswith(">") or nstr.startswith("```") or is_table_row(nxt):
                break
            if re.match(r"^\s*[-*+]\s+", nxt) or re.match(r"^\s*\d+[.)]\s+", nxt):
                break
            para_lines.append(nxt.rstrip())
            i += 1
        text = "\n".join(s.rstrip("  ").strip() for s in para_lines)
        add_paragraph_with_text(doc, text)
        i += 1


def set_table_width(table, widths_twips: list[int]):
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    tbl_pr = table._tbl.tblPr
    tbl_w = tbl_pr.find(qn("w:tblW"))
    if tbl_w is None:
        tbl_w = OxmlElement("w:tblW")
        tbl_pr.append(tbl_w)
    tbl_w.set(qn("w:w"), str(sum(widths_twips)))
    tbl_w.set(qn("w:type"), "dxa")

    for row in table.rows:
        for idx, cell in enumerate(row.cells):
            if idx < len(widths_twips):
                tc_pr = cell._tc.get_or_add_tcPr()
                tc_w = tc_pr.find(qn("w:tcW"))
                if tc_w is None:
                    tc_w = OxmlElement("w:tcW")
                    tc_pr.append(tc_w)
                tc_w.set(qn("w:w"), str(widths_twips[idx]))
                tc_w.set(qn("w:type"), "dxa")
                cell.width = Pt(widths_twips[idx] / 20)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP
            tc_pr = cell._tc.get_or_add_tcPr()
            tc_mar = tc_pr.first_child_found_in("w:tcMar")
            if tc_mar is None:
                tc_mar = OxmlElement("w:tcMar")
                tc_pr.append(tc_mar)
            for margin_name, value in [("top", 80), ("start", 80), ("bottom", 80), ("end", 80)]:
                node = tc_mar.find(qn(f"w:{margin_name}"))
                if node is None:
                    node = OxmlElement(f"w:{margin_name}")
                    tc_mar.append(node)
                node.set(qn("w:w"), str(value))
                node.set(qn("w:type"), "dxa")
            for p in cell.paragraphs:
                set_paragraph_spacing(p, before=0, after=0, line=1.0)
                for run in p.runs:
                    run.font.size = Pt(8.2 if len(table.rows) > 4 else 8.8)


def add_page_number_footer(doc: Document):
    for section in doc.sections:
        section.footer_distance = Cm(1.25)
        p = section.footer.paragraphs[0]
        p.clear()
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        set_paragraph_spacing(p, before=0, after=0, line=1.0)
        run = p.add_run()
        fld_begin = OxmlElement("w:fldChar")
        fld_begin.set(qn("w:fldCharType"), "begin")
        run._r.append(fld_begin)
        instr = OxmlElement("w:instrText")
        instr.set(qn("xml:space"), "preserve")
        instr.text = " PAGE "
        run._r.append(instr)
        fld_sep = OxmlElement("w:fldChar")
        fld_sep.set(qn("w:fldCharType"), "separate")
        run._r.append(fld_sep)
        txt = OxmlElement("w:t")
        txt.text = "1"
        run._r.append(txt)
        fld_end = OxmlElement("w:fldChar")
        fld_end.set(qn("w:fldCharType"), "end")
        run._r.append(fld_end)
        run.font.size = Pt(9)


def apply_readability_profile(doc: Document):
    """Apply the user's preferred A4 readability profile.

    Base line spacing is always 1.0. Extra readability comes from paragraph
    spacing before headings and after prose blocks, not from loose line spacing.
    """
    for style_name in ["Normal", "Heading 1", "Heading 2", "Heading 3", "List Bullet"]:
        try:
            doc.styles[style_name].paragraph_format.line_spacing = 1.0
        except Exception:
            pass

    for p in doc.paragraphs:
        text = (p.text or "").strip()
        if not text:
            continue
        style = p.style.name if p.style else ""
        p.paragraph_format.line_spacing = 1.0
        if style == "Heading 1":
            set_paragraph_spacing(p, before=0, after=12, line=1.0)
        elif style == "Heading 2":
            set_paragraph_spacing(p, before=22, after=10, line=1.0)
        elif style == "Heading 3":
            set_paragraph_spacing(p, before=14, after=6, line=1.0)
        elif style == "Normal" and "\n" in text and any("\u4e00" <= ch <= "\u9fff" for ch in text):
            set_paragraph_spacing(p, before=0, after=12, line=1.0)
        elif style == "Normal":
            set_paragraph_spacing(p, before=0, after=6, line=1.0)
        elif style.startswith("List"):
            set_paragraph_spacing(p, before=0, after=2, line=1.0)

    usable_width = 9020
    for table in doc.tables:
        if len(table.columns) == 3:
            if len(table.rows) <= 4:
                set_table_width(table, [1800, 2200, 5020])
            else:
                set_table_width(table, [1500, 2100, 5420])
        elif len(table.columns):
            set_table_width(table, [usable_width // len(table.columns)] * len(table.columns))

    add_page_number_footer(doc)


def strip_heading_keep_marks(docx_path: Path):
    """Remove keep-with-next/keep-lines XML that Word shows as black squares.

    python-docx's built-in heading styles may retain these flags even when the
    paragraph format is reset. This post-process keeps visible text unchanged.
    """
    replacements = {
        '<w:keepNext/>': '',
        '<w:keepLines/>': '',
        '<w:keepNext w:val="0"/>': '',
        '<w:keepLines w:val="0"/>': '',
        '<w:keepNext w:val="false"/>': '',
        '<w:keepLines w:val="false"/>': '',
    }
    with tempfile.NamedTemporaryFile(delete=False, suffix='.docx') as tmp:
        tmp_path = Path(tmp.name)
    with zipfile.ZipFile(docx_path, 'r') as zin, zipfile.ZipFile(tmp_path, 'w', compression=zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename in {'word/styles.xml', 'word/document.xml'}:
                text = data.decode('utf-8')
                for old, new in replacements.items():
                    text = text.replace(old, new)
                data = text.encode('utf-8')
            zout.writestr(item, data)
    tmp_path.replace(docx_path)


def main() -> int:
    args = parse_args()
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    markdown = input_path.read_text(encoding="utf-8")
    accent = normalize_hex(args.accent)

    doc = Document()
    style_document(doc, accent)
    title = args.title or next((m.group(1).strip() for m in re.finditer(r"^#\s+(.+)$", markdown, re.M)), input_path.name)
    doc.core_properties.title = title
    doc.core_properties.subject = "A4 DOCX generated from Markdown"
    doc.core_properties.keywords = f"source={input_path}; sha256={hashlib.sha256(markdown.encode('utf-8')).hexdigest()}"

    parse_markdown_to_docx(markdown, doc, accent, cover=not args.no_cover)
    apply_readability_profile(doc)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output_path)
    strip_heading_keep_marks(output_path)
    doc = Document(output_path)

    md_headings = count_markdown_headings(markdown)
    docx_headings = count_docx_headings(doc)
    heading_ok = md_headings == docx_headings
    print(f"Wrote {output_path}")
    print(f"Source SHA-256: {hashlib.sha256(markdown.encode('utf-8')).hexdigest()}")
    print(f"Heading count check: {'OK' if heading_ok else 'MISMATCH'} markdown={md_headings} docx={docx_headings}")
    return 0 if heading_ok else 3


if __name__ == "__main__":
    raise SystemExit(main())
