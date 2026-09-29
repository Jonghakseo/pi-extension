#!/usr/bin/env python3
"""Audit explicit typography and pagination throughout a DOCX archive."""
import argparse
import importlib.util
import math
import re
import sys
import zipfile
from pathlib import Path

from docx import Document
from lxml import etree as ET

from ooxml_order import order_error

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}


def enabled(node):
    """Interpret OOXML on/off flags, including absent values."""
    return node is not None and node.get(f'{{{W}}}val', 'true').lower() not in ('0', 'false', 'off')


def audit(args):
    """Return errors and observed font and size sets."""
    errors, fonts, sizes = [], set(), set()
    page = False
    with zipfile.ZipFile(args.input) as archive:
        bad = archive.testzip()
        if bad:
            errors.append(f'ZIP integrity failure: {bad}')
        for name in archive.namelist():
            if not (name.startswith('word/') and name.endswith('.xml')):
                continue
            root = ET.fromstring(archive.read(name))
            def fail(message):
                errors.append(f'{name}: {message}')
            for node in root.iter():
                error = order_error(node)
                if error:
                    fail(error)
            for node in root.findall('.//w:rFonts', NS):
                values = [node.get(f'{{{W}}}{s}') for s in ('ascii', 'hAnsi', 'eastAsia', 'cs')]
                fonts.update(v for v in values if v is not None)
                if any(v not in args.fonts for v in values):
                    fail(f'Missing or disallowed font slot: {values}')
                if any('theme' in key.lower() for key in node.attrib):
                    fail('Theme font attribute bypasses named faces')
            for node in root.xpath('.//w:sz | .//w:szCs', namespaces=NS):
                value = float(node.get(f'{{{W}}}val')) / 2
                sizes.add(value)
                if value not in args.sizes or value < args.min_size:
                    fail(f'Disallowed or undersized font: {value:g} pt')
            if args.no_bold and any(enabled(n) for n in root.xpath('.//w:b | .//w:bCs', namespaces=NS)):
                fail('Enabled bold/bCs flag')
            for forbidden in ('numPr', 'keepNext', 'keepLines'):
                if root.find(f'.//w:{forbidden}', NS) is not None:
                    fail(f'Forbidden w:{forbidden}')
            for node in root.findall('.//w:pPr/w:spacing', NS):
                if node.get(f'{{{W}}}line') != '240' or node.get(f'{{{W}}}lineRule', 'auto') != 'auto':
                    fail('Line spacing is not 1.0')
            for p in root.findall('.//w:p', NS):
                spacing = p.find('w:pPr/w:spacing', NS)
                if spacing is None or spacing.get(f'{{{W}}}line') != '240':
                    fail('Paragraph lacks explicit 1.0 line spacing')
                text = ''.join(p.itertext())
                if re.search(r'<\s*br\s*/?\s*>|&lt;\s*br\s*/?\s*&gt;', text, re.I):
                    fail('Literal <br> text')
            for table in root.findall('.//w:tbl', NS):
                for index, row in enumerate(table.findall('w:tr', NS)):
                    if not enabled(row.find('w:trPr/w:cantSplit', NS)):
                        fail('Table row may split')
                    if index == 0 and not enabled(row.find('w:trPr/w:tblHeader', NS)):
                        fail('Table first row does not repeat')
            if name.startswith('word/footer'):
                instructions = root.xpath('.//w:instrText/text() | .//w:fldSimple/@w:instr', namespaces=NS)
                page |= any(re.match(r'^\s*PAGE(?:\s|$)', s, re.I) for s in instructions)
    if not page:
        errors.append('Footer PAGE field missing')
    if not fonts or not sizes:
        errors.append('Explicit font/size declarations missing')
    if args.exact_sizes and sizes != args.sizes:
        errors.append(f'Exact size set mismatch: expected {sorted(args.sizes)}')
    if args.source:
        # Match the bundled converter/checker Markdown dialect.
        spec = importlib.util.spec_from_file_location('a4_check', Path(__file__).with_name('check-a4-docx.py'))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        md = args.source.read_text(encoding='utf-8')
        doc = Document(args.input)
        text_error = helper.check_full_ordered_text(md, doc)
        if text_error:
            errors.append(text_error)
        else:
            print("Full ordered text: OK")
        headings = helper.docx_heading_count(doc)
        tables = len(doc.tables)
        print(f'Headings: {headings}; tables: {tables}')
        if helper.markdown_heading_count(md) != headings:
            errors.append('Source heading count mismatch')
        if helper.markdown_table_count(md) != tables:
            errors.append('Source table count mismatch')
    return errors, fonts, sizes


def main():
    """Parse the allowed typography contract and report violations."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--fonts', required=True, help='Pipe-separated named font faces')
    parser.add_argument('--sizes', required=True, help='Comma-separated pt sizes')
    parser.add_argument('--min-size', required=True, type=float)
    parser.add_argument('--no-bold', action='store_true')
    parser.add_argument('--exact-sizes', action='store_true')
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    args.fonts = {f.strip() for f in args.fonts.split('|')}
    try:
        args.sizes = {float(s) for s in args.sizes.split(',')}
    except ValueError:
        parser.error('--sizes must contain numbers separated by commas')
    if '' in args.fonts or not 1 <= len(args.sizes) <= 3 or any(not math.isfinite(s) or s <= 0 for s in args.sizes | {args.min_size}):
        parser.error('Provide nonempty fonts and 1–3 positive finite sizes and min-size')
    try:
        errors, fonts, sizes = audit(args)
    except Exception as exc:
        print(f'Typography check: FAIL: {exc}', file=sys.stderr)
        return 1
    print(f'Fonts: {sorted(fonts)}')
    print(f'Sizes (pt): {sorted(sizes)}')
    print('Typography check: ' + ('FAIL' if errors else 'PASS'))
    for error in dict.fromkeys(errors):
        print(f'- {error}')
    if not errors:
        print('ZIP, footer PAGE, spacing and table pagination: PASS')
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
