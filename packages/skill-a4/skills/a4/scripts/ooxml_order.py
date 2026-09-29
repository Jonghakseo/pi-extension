"""Word property order, following python-docx tag sequences and OOXML change tails."""
from lxml import etree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
CT_RPR_ORDER = tuple('''rStyle rFonts b bCs i iCs caps smallCaps strike dstrike
outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing
w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em
lang eastAsianLayout specVanish oMath rPrChange'''.split())
CT_PPR_ORDER = tuple('''pStyle keepNext keepLines pageBreakBefore framePr
widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku
wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd
snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc
textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr
sectPr pPrChange'''.split())
CT_STYLE_ORDER = tuple('''name aliases basedOn next link autoRedefine hidden
uiPriority semiHidden unhideWhenUsed qFormat locked personal personalCompose
personalReply rsid pPr rPr tblPr trPr tcPr tblStylePr'''.split())
ORDERS = {f'{{{W}}}{name}': {f'{{{W}}}{prop}': i for i, prop in enumerate(order)}
          for name, order in (('rPr', CT_RPR_ORDER), ('pPr', CT_PPR_ORDER),
                              ('style', CT_STYLE_ORDER))}


def normalize_order(parent):
    """Sort known properties in their existing slots; retain unknown nodes in place."""
    ranks = ORDERS.get(parent.tag)
    if ranks is None:
        return
    children = list(parent)
    known = iter(sorted((n for n in children if n.tag in ranks),
                        key=lambda n: ranks[n.tag]))
    ordered = [next(known) if n.tag in ranks else n for n in children]
    if ordered != children:
        parent[:] = ordered


def ordered_property(parent, name):
    """Find/create a property and restore schema order, including existing properties."""
    node = parent.find(f'{{{W}}}{name}')
    if node is None:
        node = ET.SubElement(parent, f'{{{W}}}{name}')
    normalize_order(parent)
    return node


def order_error(parent):
    """Return a located diagnostic for out-of-order known properties, if any."""
    ranks = ORDERS.get(parent.tag)
    if ranks is None:
        return None
    observed = [ranks[n.tag] for n in parent if n.tag in ranks]
    if observed != sorted(observed):
        names = [ET.QName(n).localname for n in parent if isinstance(n.tag, str)]
        return f'Property order violation at {parent.getroottree().getpath(parent)}: {names}'
    return None
