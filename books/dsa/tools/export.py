#!/usr/bin/env python3
"""Export the authored DSA book as a self-contained EPUB 3 file."""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path

import publication
from reader import render_markdown


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="output path (defaults to books/dsa/dist/<edition>.epub)")
    args = parser.parse_args(argv)
    destination = args.output or publication.runner.BOOK_DIR / "dist" / publication.epub_filename()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(publication.build_epub(render_markdown))
    with zipfile.ZipFile(destination) as archive:
        archive.testzip()
        entries = len(archive.namelist())
    print(f"EPUB {publication.load_metadata().edition}: {destination} ({entries} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
