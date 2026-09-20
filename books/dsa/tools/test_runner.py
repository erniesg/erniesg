"""Unit tests for the book grader's pure logic (discovery, tiers, progress)."""

import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import runner


def make_chapter(root: Path, chapter_id: str = "ch99", tiers=("public", "stress")) -> Path:
    path = root / f"{chapter_id}-test-chapter"
    (path / "tests").mkdir(parents=True)
    (path / "starter").mkdir()
    (path / "solution").mkdir()
    (path / "exercise.toml").write_text(
        f'id = "{chapter_id}"\n'
        f'title = "Test Chapter"\n'
        f'module = "thing"\n'
        "[tiers.public]\nxp = 7\ntimeout = 5\n"
    )
    for tier in tiers:
        (path / "tests" / f"test_{tier}.py").write_text(
            "import unittest\n"
            "class T(unittest.TestCase):\n"
            "    def test_ok(self):\n"
            "        self.assertTrue(True)\n"
            "if __name__ == '__main__':\n"
            "    unittest.main()\n"
        )
    return path


class ChapterLoadingTests(unittest.TestCase):
    def test_loads_declared_and_default_tier_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = make_chapter(Path(tmp))
            chapter = runner.load_chapter(path)
        self.assertEqual(chapter.id, "ch99")
        self.assertEqual([t.name for t in chapter.tiers], ["public", "stress"])
        public, stress = chapter.tiers
        self.assertEqual(public.xp, 7)          # declared in exercise.toml
        self.assertEqual(public.timeout, 5)
        self.assertEqual(stress.xp, runner.DEFAULT_XP["stress"])  # fallback
        self.assertEqual(stress.timeout, runner.DEFAULT_TIMEOUT["stress"])

    def test_tiers_follow_canonical_order_not_file_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = make_chapter(Path(tmp), tiers=("perf", "public", "edge"))
            chapter = runner.load_chapter(path)
        self.assertEqual([t.name for t in chapter.tiers], ["public", "edge", "perf"])


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.chapter = runner.load_chapter(make_chapter(Path(self.tmp.name)))
        self.progress = {
            "chapters": {}, "xp": 0, "badges": [],
            "streak": {"days": 0, "last": None},
        }

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_pass_awards_xp_once(self):
        tier = self.chapter.tiers[0]
        runner.record_pass(self.progress, self.chapter, tier)
        runner.record_pass(self.progress, self.chapter, tier)
        self.assertEqual(self.progress["xp"], 7)
        self.assertTrue(self.progress["chapters"]["ch99"]["public"]["passed"])

    def test_all_tiers_green_earns_first_green_badge(self):
        earned = []
        for tier in self.chapter.tiers:
            earned += runner.record_pass(self.progress, self.chapter, tier)
        self.assertIn("first-green", earned)
        self.assertIn("stress-buster", earned)  # stress tier was among them
        # badges are one-time
        again = runner.record_pass(self.progress, self.chapter, self.chapter.tiers[0])
        self.assertEqual(again, [])

    def test_streak_increments_on_consecutive_days_and_resets_after_gap(self):
        tier_a, tier_b = self.chapter.tiers
        runner.record_pass(self.progress, self.chapter, tier_a, today=date(2026, 7, 1))
        self.assertEqual(self.progress["streak"]["days"], 1)
        runner.record_pass(self.progress, self.chapter, tier_b, today=date(2026, 7, 2))
        self.assertEqual(self.progress["streak"]["days"], 2)
        # a new chapter pass after a gap resets the streak to 1
        other = runner.load_chapter(make_chapter(Path(self.tmp.name), "ch98"))
        runner.record_pass(self.progress, other, other.tiers[0], today=date(2026, 7, 9))
        self.assertEqual(self.progress["streak"]["days"], 1)


class RunTierTests(unittest.TestCase):
    def test_failing_test_reports_fail_and_passing_reports_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = make_chapter(Path(tmp), tiers=("public",))
            (path / "tests" / "test_public.py").write_text(
                "import unittest\n"
                "from bookgrader import load_solution\n"
                "class T(unittest.TestCase):\n"
                "    def test_add(self):\n"
                "        self.assertEqual(load_solution('thing').add(2, 3), 5)\n"
                "if __name__ == '__main__':\n"
                "    unittest.main()\n"
            )
            (path / "solution" / "thing.py").write_text("def add(a, b):\n    return a + b\n")
            (path / "starter" / "thing.py").write_text("def add(a, b):\n    return 0\n")
            chapter = runner.load_chapter(path)
            tier = chapter.tiers[0]
            outcome_good, _ = runner.run_tier(chapter, tier, path / "solution")
            outcome_bad, output_bad = runner.run_tier(chapter, tier, path / "starter")
        self.assertEqual(outcome_good, "pass")
        self.assertEqual(outcome_bad, "fail")
        self.assertIn("AssertionError", output_bad)

    def test_timeout_is_reported_not_hung(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = make_chapter(Path(tmp), tiers=("public",))
            (path / "exercise.toml").write_text(
                'id = "ch99"\ntitle = "T"\nmodule = "thing"\n'
                "[tiers.public]\ntimeout = 1\n"
            )
            (path / "tests" / "test_public.py").write_text(
                "import time\ntime.sleep(10)\n"
            )
            chapter = runner.load_chapter(path)
            outcome, output = runner.run_tier(chapter, chapter.tiers[0], path / "solution")
        self.assertEqual(outcome, "timeout")
        self.assertIn("1s", output)


if __name__ == "__main__":
    unittest.main()
