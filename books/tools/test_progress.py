"""The local preview merges progress exactly the way the browser does.

Both sides read `runtime/progress-fixtures.json`, so a rule changed in one and
not the other fails here or in `runtime/progress.test.mjs`.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import progress  # noqa: E402

FIXTURES = json.loads((Path(__file__).parent / "runtime" / "progress-fixtures.json").read_text())


def inflate(value):
    text = json.dumps(value).replace('"__OVERSIZED__"', json.dumps("x" * (progress.MAX_DRAFT_LENGTH + 1)))
    return json.loads(text)


class SharedFixtures(unittest.TestCase):
    def test_normalize(self):
        for fixture in FIXTURES["normalize"]:
            with self.subTest(fixture["name"]):
                self.assertEqual(progress.normalize(inflate(fixture["input"]), fixture["book"]), fixture["output"])

    def test_merge(self):
        for fixture in FIXTURES["merge"]:
            with self.subTest(fixture["name"]):
                self.assertEqual(progress.merge(fixture["a"], fixture["b"]), fixture["output"])


class LocalFile(unittest.TestCase):
    def test_a_legacy_file_reads_and_a_solve_keeps_the_list_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "progress.json"
            path.write_text(json.dumps({"solved": ["sum-of-two-digits"]}))
            data = progress.read_file(path, "build-a-coding-agent")
            self.assertEqual(data["solved"], ["sum-of-two-digits"])
            data = progress.mark_solved(data, "ch03-last-three", "2026-09-28T12:00:00.000Z")
            progress.write_file(path, data)
            written = json.loads(path.read_text())
            # Anything that only ever read `solved` as a list still can.
            self.assertEqual(written["solved"], ["ch03-last-three", "sum-of-two-digits"])
            self.assertEqual(written["solvedAt"], {"ch03-last-three": "2026-09-28T12:00:00.000Z"})

    def test_an_unreadable_file_is_empty_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "progress.json"
            path.write_text("{not json")
            self.assertEqual(progress.read_file(path, "b"), progress.empty("b"))
            self.assertEqual(progress.read_file(Path(directory) / "missing.json", "b"), progress.empty("b"))

    def test_a_web_export_imports_by_merging(self):
        local = progress.mark_solved(progress.empty("b"), "sum-of-two-digits", "2026-09-27T00:00:00.000Z")
        exported = {
            "version": 1, "book": "b", "solved": ["ch03-last-three"],
            "solvedAt": {"ch03-last-three": "2026-09-28T00:00:00.000Z"},
            "drafts": {"ch03-one-copy": {"code": "print(1)", "updatedAt": "2026-09-28T00:00:00.000Z"}},
        }
        merged = progress.merge(local, exported)
        self.assertEqual(merged["solved"], ["ch03-last-three", "sum-of-two-digits"])
        self.assertEqual(merged["drafts"]["ch03-one-copy"]["code"], "print(1)")


if __name__ == "__main__":
    unittest.main()
