"""Canonical publication model and EPUB 3 export for the DSA book."""

from __future__ import annotations

import html
import io
import re
import tomllib
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import runner


BOOK_METADATA_PATH = runner.BOOK_DIR / "book.toml"
FRONTMATTER_DIR = runner.BOOK_DIR / "frontmatter"
MIMETYPE = "application/epub+zip"


@dataclass(frozen=True)
class BookPart:
    id: str
    number: str
    title: str
    description: str


@dataclass(frozen=True)
class BookMetadata:
    title: str
    short_title: str
    subtitle: str
    author: str
    language: str
    identifier: str
    publisher: str
    description: str
    rights: str
    modified: str
    edition: str
    parts: tuple[BookPart, ...]


def load_metadata() -> BookMetadata:
    payload = tomllib.loads(BOOK_METADATA_PATH.read_text())
    book = payload["book"]
    parts = tuple(BookPart(**part) for part in payload.get("parts", []))
    return BookMetadata(
        **book,
        edition=(runner.BOOK_DIR / "VERSION").read_text().strip(),
        parts=parts,
    )


def frontmatter(markdown: str) -> tuple[dict[str, str], str]:
    lines = markdown.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, markdown
    metadata: dict[str, str] = {}
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return metadata, "\n".join(lines[index + 1 :])
        key, separator, value = line.partition(":")
        if separator:
            metadata[key.strip()] = value.strip().strip('"')
    return {}, markdown


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "section"


def headings(markdown: str, minimum: int = 2, maximum: int = 3) -> list[dict]:
    _, body = frontmatter(markdown)
    values = []
    in_code = False
    for line in body.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        match = re.match(r"^(#{1,6})\s+(.+)$", line.strip())
        if not match:
            continue
        depth = len(match.group(1))
        if minimum <= depth <= maximum:
            label = re.sub(r"[*_`]", "", match.group(2)).strip()
            values.append({"depth": depth, "label": label, "id": slug(label)})
    return values


def _xml(value: str) -> str:
    return html.escape(value, quote=True).replace("&#x27;", "&apos;")


def _xhtml(title: str, body: str, language: str, body_class: str = "chapter") -> str:
    return f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{_xml(language)}" lang="{_xml(language)}">
<head><meta charset="utf-8"/><title>{_xml(title)}</title><link rel="stylesheet" type="text/css" href="styles/book.css"/></head>
<body class="{body_class}">{body}</body></html>'''


def _cover_svg(metadata: BookMetadata) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600" role="img" aria-labelledby="title desc">
<title id="title">{_xml(metadata.title)}</title><desc id="desc">Book cover</desc>
<rect width="1200" height="1600" fill="#f2efe7"/><rect x="84" y="84" width="1032" height="1432" fill="none" stroke="#1b1b18" stroke-width="2"/>
<text x="90" y="220" fill="#1b1b18" font-family="sans-serif" font-size="48" font-weight="700" letter-spacing="3">R/ RUCKSACK</text>
<text x="90" y="350" fill="#65645e" font-family="sans-serif" font-size="24" letter-spacing="5">A BOOK FROM ERNIE.SG STUDY · EDITION {metadata.edition}</text>
<text x="90" y="590" fill="#1b1b18" font-family="serif" font-size="118"><tspan x="90" dy="0">The Rucksack</tspan><tspan x="90" dy="132">Book of Data</tspan><tspan x="90" dy="132">Structures &amp;</tspan><tspan x="90" dy="132">Algorithms</tspan></text>
<line x1="90" y1="1190" x2="1110" y2="1190" stroke="#1b1b18" stroke-width="2"/>
<text x="90" y="1260" fill="#65645e" font-family="sans-serif" font-size="31">{_xml(metadata.subtitle)}</text>
<text x="90" y="1430" fill="#1b1b18" font-family="sans-serif" font-size="34">{_xml(metadata.author)}</text></svg>'''


EPUB_CSS = """
@page { margin: 7%; }
html { color: #1b1b18; background: #f8f6f0; }
body { margin: 0 auto; max-width: 42em; font-family: Georgia, serif; line-height: 1.62; }
h1, h2, h3 { line-height: 1.12; page-break-after: avoid; }
h1 { font-size: 2.2em; margin: 1.8em 0 .8em; }
h2 { font-size: 1.45em; margin: 2em 0 .65em; }
h3 { font: 700 1.05em sans-serif; margin-top: 1.8em; }
p, li { orphans: 3; widows: 3; }
a { color: #1b1b18; text-decoration-thickness: .06em; text-underline-offset: .14em; }
pre { padding: 1em; overflow-wrap: anywhere; white-space: pre-wrap; background: #e9e5db; font: .8em/1.55 monospace; }
code { font-family: monospace; }
table { width: 100%; border-collapse: collapse; font: .82em/1.4 sans-serif; }
th, td { padding: .55em; border-bottom: 1px solid #aaa79f; text-align: left; vertical-align: top; }
.cover { margin: 0; max-width: none; text-align: center; }
.cover img { display: block; width: 100%; height: auto; }
.title-page { display: flex; min-height: 80vh; flex-direction: column; justify-content: center; }
.title-page .kicker, .title-page .meta { font: .75em/1.5 sans-serif; letter-spacing: .12em; text-transform: uppercase; }
.title-page h1 { font-size: 3em; }
.contents ol { padding-left: 1.3em; }
.contents li { margin: .65em 0; }
.part { margin-top: 2em; font: 700 .8em/1.4 sans-serif; letter-spacing: .1em; text-transform: uppercase; }
""".strip()


def build_epub(render_markdown: Callable[[str], str]) -> bytes:
    metadata = load_metadata()
    chapters = runner.discover_chapters()
    preface_markdown = (FRONTMATTER_DIR / "preface.md").read_text()
    preface_html = render_markdown(preface_markdown)

    nav_items = ['<li><a href="text/preface.xhtml">How to read this book</a></li>']
    manifest_items = [
        '<item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>',
        '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="title-page" href="text/title.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="preface" href="text/preface.xhtml" media-type="application/xhtml+xml"/>',
    ]
    spine_items = ['<itemref idref="cover-page" linear="no"/>', '<itemref idref="title-page"/>', '<itemref idref="preface"/>']
    chapter_files: list[tuple[str, bytes]] = []
    current_part = None
    for position, chapter in enumerate(chapters, start=1):
        markdown = (chapter.path / "chapter.md").read_text()
        chapter_meta, _ = frontmatter(markdown)
        part = chapter_meta.get("part", "I")
        if part != current_part:
            part_meta = next((item for item in metadata.parts if item.number == part), None)
            part_title = part_meta.title if part_meta else f"Part {part}"
            nav_items.append(f'<li class="part">Part {_xml(part)} — {_xml(part_title)}</li>')
            current_part = part
        filename = f"chapter-{position:02d}.xhtml"
        item_id = f"chapter-{position:02d}"
        nav_items.append(f'<li><a href="text/{filename}">{position}. {_xml(chapter.title)}</a></li>')
        manifest_items.append(f'<item id="{item_id}" href="text/{filename}" media-type="application/xhtml+xml"/>')
        spine_items.append(f'<itemref idref="{item_id}"/>')
        chapter_files.append((f"OEBPS/text/{filename}", _xhtml(chapter.title, render_markdown(markdown), metadata.language).encode()))

    nav = _xhtml(
        "Contents",
        f'<nav epub:type="toc" id="toc" xmlns:epub="http://www.idpf.org/2007/ops"><h1>Contents</h1><ol>{"".join(nav_items)}</ol></nav>',
        metadata.language,
        "contents",
    )
    title_body = f'''<main class="title-page"><p class="kicker">Ernie.SG Study · Book</p><h1>{_xml(metadata.title)}</h1><p>{_xml(metadata.subtitle)}</p><p>{_xml(metadata.author)}</p><p class="meta">Executable edition {_xml(metadata.edition)}</p><p>{_xml(metadata.rights)}</p></main>'''
    package = f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="{_xml(metadata.language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">{_xml(metadata.identifier)}</dc:identifier><dc:title>{_xml(metadata.title)}</dc:title><dc:creator>{_xml(metadata.author)}</dc:creator><dc:language>{_xml(metadata.language)}</dc:language><dc:publisher>{_xml(metadata.publisher)}</dc:publisher><dc:description>{_xml(metadata.description)}</dc:description><dc:rights>{_xml(metadata.rights)}</dc:rights><meta property="dcterms:modified">{_xml(metadata.modified)}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="styles/book.css" media-type="text/css"/>{''.join(manifest_items)}</manifest>
<spine>{''.join(spine_items)}</spine></package>'''
    container = '''<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'''

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("mimetype", MIMETYPE, compress_type=zipfile.ZIP_STORED)
        archive.writestr("META-INF/container.xml", container)
        archive.writestr("OEBPS/package.opf", package)
        archive.writestr("OEBPS/nav.xhtml", nav)
        archive.writestr("OEBPS/styles/book.css", EPUB_CSS)
        archive.writestr("OEBPS/cover.svg", _cover_svg(metadata))
        archive.writestr("OEBPS/text/cover.xhtml", _xhtml("Cover", '<img src="../cover.svg" alt="Book cover"/>', metadata.language, "cover"))
        archive.writestr("OEBPS/text/title.xhtml", _xhtml("Title page", title_body, metadata.language, "title-page"))
        archive.writestr("OEBPS/text/preface.xhtml", _xhtml("How to read this book", preface_html, metadata.language))
        for path, contents in chapter_files:
            archive.writestr(path, contents)
    return output.getvalue()


def epub_filename(metadata: BookMetadata | None = None) -> str:
    value = metadata or load_metadata()
    return f"rucksack-dsa-{value.edition}.epub"
