"""Rule: a book tool path named in the docs, the book or the code exists.

The pool moved from challenges/ to books/. A validation command that names a
tool at its old path fails the moment someone follows it, and a test that
imports a tool from it fails too, so every `<folder>/tools/<name>.py` or
`<folder>/tools` import path must be a real file or folder.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = re.compile(r"\b((?:challenges|books)/tools/[\w-]+\.py)\b")
# A quoted tools folder, as a `sys.path` entry or a `path.join` argument names it.
TOOLS_DIR = re.compile(r"[\"']((?:challenges|books)/tools)/?[\"']")
SCANNED = ("docs", "books", ".agent", "tests", "src", "tools", "packages")


class DocumentedToolPaths(unittest.TestCase):
    def test_every_named_tool_exists(self):
        missing = []
        for folder in SCANNED:
            for path in sorted((REPO / folder).rglob("*")):
                if path.suffix not in (".md", ".toml", ".py", ".yaml", ".yml", ".ts", ".tsx", ".mjs", ".js"):
                    continue
                if {"workspace", "dist", "node_modules"} & set(path.parts):
                    continue
                text = path.read_text(errors="replace")
                for pattern, exists in ((TOOL, Path.is_file), (TOOLS_DIR, Path.is_dir)):
                    for found in pattern.finditer(text):
                        if not exists(REPO / found.group(1)):
                            line = text.count("\n", 0, found.start()) + 1
                            missing.append(f"{path.relative_to(REPO)}:{line}: {found.group(1)}")
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
