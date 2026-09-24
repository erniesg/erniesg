#!/usr/bin/env python3
"""Build the EPUB from the same nodes the web edition reads.

    python3 books/tools/epub.py            -> books/dist/<slug>-<edition>.epub

The markup comes from render.py with target="print", the same module the web
edition uses. This file only packages what that returns.

Stdlib only. This is the scaffold: the published EPUB will come from the repo's
struct packager, which also runs EPUBCheck.
"""

from __future__ import annotations

import html
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

if sys.version_info < (3, 11):
    sys.exit(f"This needs Python 3.11+; this is Python {sys.version.split()[0]}.")

import tomllib

from render import BOOKS, PRINT_CSS, load_book, render_node

DIST = BOOKS / "dist"

def xhtml(title: str, body: str) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en"><head>'
        f"<title>{html.escape(title)}</title>"
        '<link rel="stylesheet" type="text/css" href="style.css"/>'
        f"</head><body>{body}</body></html>"
    )


def build() -> Path:
    book, order = load_book()
    slug = book.get("slug", "book")
    edition = book.get("edition", "0.0.0")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    import uuid

    # a real UUID, derived so the same edition always gets the same identifier
    identifier = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, f'https://ernie.sg/study/{slug}/{edition}')}"

    documents = []
    for index, node in enumerate(order):
        name = f"{index:02d}-{node['id']}.xhtml"
        documents.append((name, node["title"], xhtml(node["title"], render_node(node, "print"))))

    nav_items = "".join(
        f'<li><a href="{name}">{html.escape(title)}</a></li>' for name, title, _ in documents
    )
    nav = xhtml(
        "Contents",
        f"<nav epub:type='toc' id='toc' xmlns:epub='http://www.idpf.org/2007/ops'>"
        f"<h1>Contents</h1><ol>{nav_items}</ol></nav>",
    )

    manifest = "".join(
        f'<item id="d{index}" href="{name}" media-type="application/xhtml+xml"/>'
        for index, (name, _, _) in enumerate(documents)
    )
    spine = "".join(f'<itemref idref="d{index}"/>' for index in range(len(documents)))
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">{identifier}</dc:identifier>
    <dc:title>{html.escape(book.get('title', 'Book'))}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>{html.escape(book.get('author', ''))}</dc:creator>
    <meta property="dcterms:modified">{stamp}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>{manifest}
  </manifest>
  <spine><itemref idref="nav"/>{spine}</spine>
</package>"""

    container = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
    media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

    DIST.mkdir(parents=True, exist_ok=True)
    target = DIST / f"{slug}-{edition}.epub"
    with zipfile.ZipFile(target, "w") as archive:
        # the mimetype entry must be first and stored, not deflated
        archive.writestr(
            zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED
        )
        archive.writestr("META-INF/container.xml", container, zipfile.ZIP_DEFLATED)
        archive.writestr("OEBPS/content.opf", opf, zipfile.ZIP_DEFLATED)
        archive.writestr("OEBPS/nav.xhtml", nav, zipfile.ZIP_DEFLATED)
        archive.writestr("OEBPS/style.css", PRINT_CSS, zipfile.ZIP_DEFLATED)
        for name, _, document in documents:
            archive.writestr(f"OEBPS/{name}", document, zipfile.ZIP_DEFLATED)
    return target


def print_preview() -> str:
    """The EPUB's own markup, shown in the browser so you can read it here."""
    _, order = load_book()
    return "".join(
        f"<article class='print-page' id='print-{node['id']}'>{render_node(node, 'print')}</article>"
        for node in order
    )


if __name__ == "__main__":
    built = build()
    size = built.stat().st_size
    print(f"{built} ({size:,} bytes)")
