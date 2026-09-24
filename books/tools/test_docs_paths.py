"""Rule: a book tool path named in the docs or the book exists.

The pool moved from challenges/ to books/. A validation command that names a
tool at its old path fails the moment someone follows it, so every
`<folder>/tools/<name>.py` mentioned in a document must be a real file.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = re.compile(r"\b((?:challenges|books)/tools/[\w-]+\.py)\b")
SCANNED = ("docs", "books", ".agent")


class DocumentedToolPaths(unittest.TestCase):
    def test_every_named_tool_exists(self):
        missing = []
        for folder in SCANNED:
            for path in sorted((REPO / folder).rglob("*")):
                if path.suffix not in (".md", ".toml", ".py", ".yaml", ".yml"):
                    continue
                if "workspace" in path.parts or "dist" in path.parts:
                    continue
                text = path.read_text(errors="replace")
                for found in TOOL.finditer(text):
                    if not (REPO / found.group(1)).is_file():
                        line = text.count("\n", 0, found.start()) + 1
                        missing.append(f"{path.relative_to(REPO)}:{line}: {found.group(1)}")
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
