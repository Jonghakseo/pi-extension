"""Structural Markdown view matching the converter's backtick fences."""


def outside_code_fences(markdown: str) -> str:
    """Mask fences and their contents without joining formerly separate lines."""
    lines = []
    in_code = False
    for line in markdown.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
            lines.append("")
        else:
            lines.append("" if in_code else line)
    return "\n".join(lines)
