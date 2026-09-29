#!/usr/bin/env python3
"""Apply named font faces to every WordprocessingML part without rewriting content."""
import argparse
import math
import re
import sys
import zipfile
from pathlib import Path

from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from lxml import etree as ET

from ooxml_order import ORDERS, normalize_order, ordered_property

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}


def tag(name):
    """Return a WordprocessingML qualified name."""
    return f'{{{W}}}{name}'


def child(parent, name):
    """Find or append a property element."""
    if parent.tag in ORDERS:
        return ordered_property(parent, name)
    node = parent.find(tag(name))
    if node is None:
        node = ET.SubElement(parent, tag(name))
    return node


def style_property(style, name):
    """Insert style properties in CT_Style order, retaining existing children."""
    successors = {
        'pPr': {'rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr'},
        'rPr': {'tblPr', 'trPr', 'tcPr', 'tblStylePr'},
    }
    node = child(style, name)
    style.remove(node)
    for index, sibling in enumerate(style):
        if sibling.tag in {tag(n) for n in successors[name]}:
            style.insert(index, node)
            break
    else:
        style.append(node)
    return node


def properties(parent, name):
    """Ensure properties precede content."""
    node = child(parent, name)
    parent.remove(node)
    parent.insert(0, node)
    return node


def enabled(node):
    """Interpret OOXML on/off values."""
    return node is not None and node.get(tag('val'), 'true').lower() not in ('0', 'false', 'off')


def format_run(rpr, face, size, monochrome):
    """Set all script slots explicitly and disable synthetic bold."""
    fonts = child(rpr, 'rFonts')
    fonts.attrib.clear()
    for slot in ('ascii', 'hAnsi', 'eastAsia', 'cs'):
        fonts.set(tag(slot), face)
    for name in ('sz', 'szCs'):
        child(rpr, name).set(tag('val'), str(round(size * 2)))
    for name in ('b', 'bCs'):
        child(rpr, name).set(tag('val'), '0')
    if monochrome:
        color = child(rpr, 'color')
        color.attrib.clear()
        color.set(tag('val'), '000000')


def normalize(root, args, heading_styles):
    """Normalize defaults, styles, paragraphs, runs and table pagination."""
    bold_runs = {r for r in root.iter(tag('r')) if any(enabled(r.find(f'{tag("rPr")}/{tag(n)}')) for n in ('b', 'bCs'))}
    for name in ('numPr', 'keepNext', 'keepLines'):
        for node in list(root.iter(tag(name))):
            node.getparent().remove(node)
    for rpr in root.iter(tag('rPr')):
        format_run(rpr, args.regular_face, args.body_size, args.monochrome)

    def choice(level):
        if level == 1:
            return args.semibold_face, args.title_size
        if level == 2:
            return args.semibold_face, args.section_size
        if level:
            return args.medium_face, args.body_size
        return args.regular_face, args.body_size

    for style in root.iter(tag('style')):
        face, size = choice(heading_styles.get(style.get(tag('styleId'))))
        format_run(style_property(style, 'rPr'), face, size, args.monochrome)
        # Numbering styles retain existing pPr but need no new paragraph defaults.
        if style.get(tag('type')) in ('paragraph', 'table'):
            child(style_property(style, 'pPr'), 'spacing').set(tag('line'), '240')
    for p in root.iter(tag('p')):
        ppr = properties(p, 'pPr')
        style = ppr.find(tag('pStyle'))
        level = heading_styles.get(style.get(tag('val'))) if style is not None else None
        face, size = choice(level)
        row = next((a for a in p.iterancestors(tag('tr'))), None)
        if row is not None:
            table = row.getparent()
            face, size = (args.medium_face if table.find(tag('tr')) is row else args.regular_face), args.body_size
        format_run(child(ppr, 'rPr'), face, size, args.monochrome)
        for run in p.iter(tag('r')):
            run_face = args.semibold_face if run in bold_runs and not level else face
            format_run(properties(run, 'rPr'), run_face, size, args.monochrome)
        child(ppr, 'spacing').set(tag('line'), '240')
    # Include dormant defaults and tracked formatting, not only visible paragraphs.
    for spacing in root.findall('.//w:pPr/w:spacing', NS):
        spacing.set(tag('line'), '240')
        spacing.set(tag('lineRule'), 'auto')
    for table in root.iter(tag('tbl')):
        for index, row in enumerate(table.findall(tag('tr'))):
            trpr = properties(row, 'trPr')
            child(trpr, 'cantSplit').set(tag('val'), '1')
            if index == 0:
                child(trpr, 'tblHeader').set(tag('val'), '1')
    if args.monochrome:
        for cell in root.iter(tag('tc')):
            shade = child(properties(cell, 'tcPr'), 'shd')
            shade.attrib.clear()
            shade.set(tag('val'), 'clear')
            shade.set(tag('fill'), 'FFFFFF')

    # Also repair dormant/tracked properties that were not visited above.
    for node in root.iter():
        normalize_order(node)


def main():
    """Validate inputs and write a separate styled DOCX."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('-o', '--output', required=True, type=Path)
    for name in ('regular', 'medium', 'semibold'):
        parser.add_argument(f'--{name}-face', required=True)
    for name, default in (('body', 10.5), ('section', 12), ('title', 16)):
        parser.add_argument(f'--{name}-size', type=float, default=default)
    parser.add_argument('--monochrome', action='store_true')
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        parser.error('Output must differ from input; original DOCX is never overwritten.')
    if any(not getattr(args, f'{n}_face').strip() for n in ('regular', 'medium', 'semibold')):
        parser.error('Font faces must not be empty.')
    sizes = [args.body_size, args.section_size, args.title_size]
    if any(not math.isfinite(s) or s <= 0 or s * 2 != round(s * 2) for s in sizes):
        parser.error('Sizes must be positive finite multiples of 0.5 pt (OOXML half-points).')
    if min(sizes) < args.body_size:
        parser.error('Title and section sizes must not be below body size.')
    try:
        doc = Document(args.input)
        headings = {}
        for style in doc.styles:
            match = re.fullmatch(r'Heading ([1-6])', style.name, re.I)
            if match:
                headings[style.style_id] = int(match.group(1))
        with zipfile.ZipFile(args.input) as source:
            if source.testzip():
                raise ValueError('Input ZIP integrity check failed.')
            parts = []
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename.startswith('word/') and info.filename.endswith('.xml'):
                    root = ET.fromstring(data)
                    normalize(root, args, headings)
                    data = ET.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
                parts.append((info, data))
        with zipfile.ZipFile(args.output, 'w') as target:
            for info, data in parts:
                target.writestr(info, data)
        print(f'Styled DOCX: {args.output}')
        return 0
    except (OSError, ValueError, PackageNotFoundError, zipfile.BadZipFile, ET.XMLSyntaxError) as exc:
        print(f'Typography apply: FAIL: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
