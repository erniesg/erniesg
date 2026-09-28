"""grade_inprocess: the browser's grader, checked against grade.py's.

The published site runs a tier inside Pyodide, where there is no subprocess.
These run the same tier both ways under CPython and require the same answer:
outcome, the calls the tests made, what each printed, and the summary line.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import grade
import grade_inprocess

NODE = grade.CHALLENGES / "pool-ticket-price"
PRINTING = '''def ticket_price(age: int) -> int:
    print("checking", age)
    if age < 5:
        return 0
    if age < 18:
        return 350
    return 620  # forgets the 65-and-over price
'''
RAISING = 'def ticket_price(age):\n    raise NotImplementedError("Write me")\n'
KEYS = ("test", "call", "returned", "raised", "out", "err", "expected", "match")


def comparable(calls):
    return [{k: call.get(k) for k in KEYS} for call in calls]


class InProcessMatchesSubprocess(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.work, True)

    def write(self, source: str) -> Path:
        (self.work / "ticket.py").write_text(source)
        return self.work

    def both(self, source: str, tier: str, sample: bool = False):
        solution = self.write(source)
        calls: list[dict] = []
        counts: dict = {}
        outcome, output = grade.run_tier(NODE, tier, solution, 60, calls=calls, sample=sample, counts=counts)
        mine = grade_inprocess.run_tier(NODE, tier, solution, sample=sample)
        return (outcome, output, calls, counts.get("total", len(calls))), mine

    def test_a_wrong_answer_with_prints_is_graded_and_recorded_the_same(self):
        (outcome, output, calls, total), mine = self.both(PRINTING, "public")
        self.assertEqual(outcome, "fail")
        self.assertEqual(mine["outcome"], outcome)
        self.assertEqual(comparable(mine["calls"]), comparable(calls))
        self.assertEqual(mine["total"], total)
        self.assertEqual(mine["summary"], grade.summarize(output, NODE / "tests" / "public.py"))
        # the print sits under its own call, not in the runner's dump
        wrong = next(c for c in mine["calls"] if c.get("match") is False)
        self.assertEqual(wrong["call"], "ticket_price(65)")
        self.assertEqual(wrong["out"], "checking 65\n")

    def test_samples_run_every_row_the_same(self):
        (_, _, calls, total), mine = self.both(PRINTING, "public", sample=True)
        self.assertEqual(comparable(mine["calls"]), comparable(calls))
        self.assertEqual(mine["total"], total)
        self.assertEqual(len(mine["calls"]), 6)

    def test_a_raise_names_the_readers_line(self):
        (outcome, output, calls, _), mine = self.both(RAISING, "public")
        self.assertEqual(mine["outcome"], outcome)
        self.assertEqual(comparable(mine["calls"]), comparable(calls))
        self.assertEqual(mine["summary"], grade.summarize(output, NODE / "tests" / "public.py"))
        self.assertIn("NotImplementedError", mine["summary"])

    def test_the_reference_solution_passes_every_tier(self):
        solution = self.work
        shutil.copyfile(NODE / "solution.py", solution / "ticket.py")
        for tier in grade.TIERS:
            with self.subTest(tier=tier):
                self.assertEqual(grade_inprocess.run_tier(NODE, tier, solution)["outcome"], "pass")

    def test_a_rewrite_of_the_same_size_is_what_runs_next(self):
        """The browser rewrites the reader's file between runs within a second."""
        wrong = PRINTING.replace("return 0", "return 9")
        self.assertEqual(len(wrong), len(PRINTING))
        first = grade_inprocess.run_tier(NODE, "public", self.write(wrong), sample=True)
        second = grade_inprocess.run_tier(NODE, "public", self.write(PRINTING), sample=True)
        self.assertEqual(first["calls"][0]["returned"], "9")
        self.assertEqual(second["calls"][0]["returned"], "0")
        self.assertFalse((self.work / "__pycache__").exists())

    def test_perf_is_never_recorded(self):
        shutil.copyfile(NODE / "solution.py", self.work / "ticket.py")
        self.assertEqual(grade_inprocess.run_tier(NODE, "perf", self.work)["calls"], [])

    def test_nothing_leaks_into_the_next_tier(self):
        """The process is shared, so each tier must leave it as it found it."""
        import unittest as ut

        before = dict(vars(ut.TestCase))
        env = dict(os.environ)
        modules = set(sys.modules)
        cwd = os.getcwd()
        argv = list(sys.argv)
        grade_inprocess.run_tier(NODE, "public", self.write(PRINTING), sample=True)
        self.assertEqual(dict(vars(ut.TestCase)), before)
        self.assertEqual(dict(os.environ), env)
        self.assertEqual(os.getcwd(), cwd)
        self.assertEqual(sys.argv, argv)
        self.assertFalse({"bookgrader", "grader_observe", "ticket"} & (set(sys.modules) - modules))
        # and a second run in the same process records exactly as the first
        again = grade_inprocess.run_tier(NODE, "public", self.work, sample=True)
        self.assertEqual(len(again["calls"]), 6)

    def test_every_challenge_reference_passes_public_in_process(self):
        for node in sorted(p for p in grade.CHALLENGES.iterdir() if (p / "challenge.md").is_file()):
            meta = grade.read_front_matter(node / "challenge.md")
            with self.subTest(node=node.name):
                work = Path(tempfile.mkdtemp())
                self.addCleanup(shutil.rmtree, work, True)
                shutil.copyfile(node / "solution.py", work / f"{meta['module']}.py")
                self.assertEqual(grade_inprocess.run_tier(node, "public", work)["outcome"], "pass")


if __name__ == "__main__":
    unittest.main()
