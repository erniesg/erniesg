"""Markdown rendering for challenge nodes.

A small, dependency-free subset: headings, paragraphs, lists, tables, code
fences, blockquotes and inline emphasis. Extracted from the first reader so
the challenges tree carries no dependency on it.
"""

from __future__ import annotations

import html
import re


def _frontmatter(markdown: str) -> tuple[dict, str]:
    """Split the +++ TOML +++ front matter from the body."""
    if markdown.startswith("+++"):
        _, raw, body = markdown.split("+++", 2)
        import tomllib

        return tomllib.loads(raw), body
    return {}, markdown


def _inline(text: str) -> str:
    """Render the small, authored inline-Markdown subset used by chapters."""
    escaped = html.escape(text, quote=True)
    code: list[str] = []

    def stash_code(match: re.Match[str]) -> str:
        code.append(f"<code>{match.group(1)}</code>")
        return f"\x00CODE{len(code) - 1}\x00"

    escaped = re.sub(r"`([^`]+)`", stash_code, escaped)
    escaped = re.sub(
        r"\[([^]]+)]\((https?://[^\s)]+|/[^\s)]*|#[^\s)]*)\)",
        r'<a href="\2">\1</a>',
        escaped,
    )
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", escaped)
    for index, fragment in enumerate(code):
        escaped = escaped.replace(f"\x00CODE{index}\x00", fragment)
    return escaped


def _split_blank(lines: list[str]) -> list[list[str]]:
    """Group lines into paragraphs on blank lines."""
    groups: list[list[str]] = [[]]
    for line in lines:
        if line:
            groups[-1].append(line)
        elif groups[-1]:
            groups.append([])
    return [group for group in groups if group]


def _is_table_separator(line: str) -> bool:
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def _table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def render_markdown(markdown: str) -> str:
    """Render a safe, dependency-free subset of Markdown for book chapters."""
    _, body = _frontmatter(markdown)
    lines = body.splitlines()
    output: list[str] = []
    paragraph: list[str] = []
    list_kind: str | None = None
    list_items: list[list[str]] = []

    def flush_paragraph() -> None:
        if paragraph:
            output.append(f"<p>{_inline(' '.join(part.strip() for part in paragraph))}</p>")
            paragraph.clear()

    def flush_list() -> None:
        nonlocal list_kind
        if not list_kind:
            return
        tag = "ol" if list_kind == "ol" else "ul"
        items = "".join(
            f"<li>{_inline(' '.join(part.strip() for part in item))}</li>"
            for item in list_items
        )
        output.append(f"<{tag}>{items}</{tag}>")
        list_items.clear()
        list_kind = None

    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if stripped.startswith("```"):
            flush_paragraph()
            flush_list()
            language = stripped[3:].strip()
            code_lines: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code_lines.append(lines[index])
                index += 1
            language_class = (
                f' class="language-{html.escape(language, quote=True)}"'
                if language
                else ""
            )
            output.append(
                f"<pre><code{language_class}>{html.escape(chr(10).join(code_lines))}</code></pre>"
            )
            index += 1
            continue

        if (
            stripped.startswith("|")
            and index + 1 < len(lines)
            and _is_table_separator(lines[index + 1])
        ):
            flush_paragraph()
            flush_list()
            headers = _table_cells(line)
            index += 2
            rows: list[list[str]] = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append(_table_cells(lines[index]))
                index += 1
            head = "".join(f"<th>{_inline(cell)}</th>" for cell in headers)
            body_rows = "".join(
                "<tr>" + "".join(f"<td>{_inline(cell)}</td>" for cell in row) + "</tr>"
                for row in rows
            )
            output.append(
                f'<div class="table-wrap"><table><thead><tr>{head}</tr></thead>'
                f"<tbody>{body_rows}</tbody></table></div>"
            )
            continue

        heading = re.match(r"^(#{1,4})\s+(.+)$", stripped)
        if heading:
            flush_paragraph()
            flush_list()
            level = len(heading.group(1))
            label = heading.group(2)
            anchor = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
            output.append(f'<h{level} id="{anchor}">{_inline(label)}</h{level}>')
            index += 1
            continue

        ordered = re.match(r"^\d+\.\s+(.+)$", stripped)
        unordered = re.match(r"^[-*]\s+(.+)$", stripped)
        if ordered or unordered:
            flush_paragraph()
            kind = "ol" if ordered else "ul"
            if list_kind and list_kind != kind:
                flush_list()
            list_kind = kind
            list_items.append([(ordered or unordered).group(1)])
            index += 1
            continue

        if stripped.startswith("> "):
            flush_paragraph()
            flush_list()
            quote: list[str] = []
            while index < len(lines) and lines[index].strip().startswith(">"):
                quote.append(lines[index].strip().lstrip(">").strip())
                index += 1
            index -= 1
            paragraphs = "".join(
                f"<p>{_inline(' '.join(chunk))}</p>"
                for chunk in _split_blank(quote)
            )
            output.append(f"<blockquote>{paragraphs}</blockquote>")
            index += 1
            continue

        if not stripped:
            flush_paragraph()
            flush_list()
            index += 1
            continue

        if list_kind and list_items:
            list_items[-1].append(stripped)
        else:
            paragraph.append(stripped)
        index += 1

    flush_paragraph()
    flush_list()
    return "\n".join(output)
