"""render.py: support notes per target, and the pre-rename workspace.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import render


class PrintSupportNotes(unittest.TestCase):
    """Rule (spec 066): print keeps a support note for every support level.

    The web drops the `worked` and `guided` notes because the hint bulb and the
    solution disclosure carry that; a printed page has neither.
    """

    def test_every_level_prints_a_note(self):
        _, order = render.load_book()
        seen: set[str] = set()
        for node in order:
            if node.get("kind") != "challenge":
                continue
            support = node.get("support", "guided")
            seen.add(support)
            printed = render.render_node(node, "print")
            with self.subTest(node["id"]):
                self.assertIn(f'class="support support-{support}"', printed)
        self.assertEqual(seen, set(render.SUPPORT_LEVELS))

    def test_every_level_has_non_empty_print_wording(self):
        for level in render.SUPPORT_LEVELS:
            self.assertTrue(render.SUPPORT_NOTES_PRINT.get(level, "").strip(), level)


class LegacyWorkspace(unittest.TestCase):
    """Rule: attempts saved before the rename stay visible after it."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.legacy = self.root / "challenges" / "workspace"
        self.current = self.root / "books" / "workspace"

    def write(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_everything_moves_when_the_new_workspace_is_new(self):
        self.write(self.legacy / "max-pairwise-product" / "pairwise.py", "mine")
        self.write(self.legacy / "progress.json", json.dumps({"solved": ["a"]}))
        left = render.migrate_legacy_workspace(self.legacy, self.current)
        self.assertEqual(left, [])
        self.assertEqual((self.current / "max-pairwise-product" / "pairwise.py").read_text(), "mine")
        self.assertEqual(json.loads((self.current / "progress.json").read_text())["solved"], ["a"])
        self.assertFalse(self.legacy.exists())

    def test_progress_merges_and_a_clash_is_left_not_overwritten(self):
        self.write(self.legacy / "progress.json", json.dumps({"solved": ["a", "b"]}))
        self.write(self.current / "progress.json", json.dumps({"solved": ["b", "c"]}))
        self.write(self.legacy / "x" / "m.py", "old attempt")
        self.write(self.current / "x" / "m.py", "new attempt")
        self.write(self.legacy / "y" / "m.py", "only old")
        left = render.migrate_legacy_workspace(self.legacy, self.current)
        self.assertEqual(
            sorted(json.loads((self.current / "progress.json").read_text())["solved"]),
            ["a", "b", "c"],
        )
        self.assertEqual((self.current / "x" / "m.py").read_text(), "new attempt")
        self.assertEqual((self.current / "y" / "m.py").read_text(), "only old")
        self.assertEqual(left, [self.legacy / "x"])
        self.assertEqual((self.legacy / "x" / "m.py").read_text(), "old attempt")

    def test_nothing_to_do_does_nothing(self):
        self.assertEqual(render.migrate_legacy_workspace(self.legacy, self.current), [])
        self.assertFalse(self.current.exists())

    def test_the_tools_that_read_the_workspace_migrate_first(self):
        # grade.py and preview.py are the two entry points that read attempts.
        for tool in ("grade.py", "preview.py"):
            source = (Path(__file__).parent / tool).read_text()
            main = source[source.index("def main("):]
            with self.subTest(tool):
                self.assertIn("report_legacy_workspace()", main)


if __name__ == "__main__":
    unittest.main()
