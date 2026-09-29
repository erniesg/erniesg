"""A tier's combined output is bounded as it is written, on every path (#398).

The recorded tiers already cap what each call prints. These cover what they
do not: the perf tier (never recorded, so its calls print straight into the
tier's combined output), top-level prints, and the local subprocess paths
that used to buffer a whole run in memory before trimming nothing at all.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import grade
import grade_inprocess
import preview
from grading import COMBINED_LIMIT_CHARS, BoundedText

NODE = grade.CHALLENGES / "pool-ticket-price"
# Correct, but prints on every call: the perf tier makes 150,000 of them.
FLOODING = '''def ticket_price(age: int) -> int:
    print("pricing age", age, "for the queue")
    if age < 5:
        return 0
    if age < 18:
        return 350
    if age < 65:
        return 620
    return 400
'''
# Wrong, after a flood at import: the failure report arrives last.
FLOOD_THEN_WRONG = '''for i in range(200_000):
    print("warming up", i)

def ticket_price(age: int) -> int:
    return 620
'''
# Most of what can be kept, plus the marker line. A subprocess keeps stdout
# and stderr apart (prints first, then the runner's report, as before), so its
# joined text may hold both ends of each.
BOUND = 2 * COMBINED_LIMIT_CHARS + 200
BOUND_TWO_STREAMS = 2 * BOUND


class TheWriterKeepsOnlyBothEnds(unittest.TestCase):
    def test_memory_stays_bounded_however_much_is_written(self):
        sink = BoundedText(limit=1000)
        for i in range(100_000):
            sink.write(f"line {i}\n")
        self.assertLessEqual(sink.stored_chars, 2 * 1000)
        text = sink.getvalue()
        self.assertTrue(text.startswith("line 0\n"))
        self.assertTrue(text.rstrip().endswith("line 99999"))
        self.assertIn("…truncated,", text)
        self.assertLessEqual(len(text), 2 * 1000 + 100)

    def test_one_huge_write_costs_no_more_than_many_small_ones(self):
        sink = BoundedText(limit=1000)
        sink.write("x" * 10_000_000 + "\nlast line\n")
        self.assertLessEqual(sink.stored_chars, 2 * 1000)
        self.assertTrue(sink.getvalue().rstrip().endswith("last line"))

    def test_output_under_the_limit_is_untouched(self):
        sink = BoundedText(limit=1000)
        sink.write("a\nb\n")
        self.assertEqual(sink.getvalue(), "a\nb\n")
        self.assertEqual(sink.dropped_lines, 0)

    def test_the_marker_counts_the_lines_that_were_let_go(self):
        sink = BoundedText(limit=100)
        for i in range(1000):
            sink.write(f"{i:03d}\n")  # 4 characters a line
        kept = [line for line in sink.getvalue().splitlines() if not line.startswith("…")]
        marker = next(line for line in sink.getvalue().splitlines() if line.startswith("…"))
        dropped = int(marker.split(",")[1].split()[0])
        self.assertEqual(len(kept) + dropped, 1000)


class EveryPathIsBounded(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.work, True)

    def solution(self, source: str) -> Path:
        (self.work / "ticket.py").write_text(source)
        return self.work

    def test_a_perf_tier_that_prints_is_bounded_in_process_and_still_graded(self):
        mine = grade_inprocess.run_tier(NODE, "perf", self.solution(FLOODING))
        self.assertLessEqual(len(mine["output"]), BOUND)
        self.assertIn("…truncated,", mine["output"])
        # the verdict is the timing's, exactly as without the cap
        quiet = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, quiet, True)
        (quiet / "ticket.py").write_text(FLOODING.replace('    print("pricing age", age, "for the queue")\n', ""))
        self.assertEqual(grade_inprocess.run_tier(NODE, "perf", quiet)["outcome"], "pass")
        self.assertIn(mine["outcome"], ("pass", "fail"))

    def test_a_perf_tier_that_prints_is_bounded_in_a_subprocess(self):
        outcome, output = grade.run_tier(NODE, "perf", self.solution(FLOODING), 60)
        self.assertLessEqual(len(output), BOUND_TWO_STREAMS)
        self.assertIn("…truncated,", output)
        self.assertIn(outcome, ("pass", "fail", "timeout"))

    def test_the_failure_report_survives_a_flood_on_both_paths(self):
        solution = self.solution(FLOOD_THEN_WRONG)
        mine = grade_inprocess.run_tier(NODE, "public", solution)
        outcome, output = grade.run_tier(NODE, "public", solution, 60)
        self.assertEqual((mine["outcome"], outcome), ("fail", "fail"))
        for text, bound in ((mine["output"], BOUND), (output, BOUND_TWO_STREAMS)):
            self.assertLessEqual(len(text), bound)
            self.assertIn("AssertionError", text)  # the tail, where unittest reports, is kept
        self.assertEqual(mine["summary"], grade.summarize(output, NODE / "tests" / "public.py"))

    def test_a_runnable_cell_that_floods_is_bounded(self):
        done = preview.run_cell([], "for i in range(300_000):\n    print('cell', i)\n", timeout=30)
        self.assertTrue(done["ok"])
        self.assertLessEqual(len(done["output"]), BOUND_TWO_STREAMS)
        self.assertIn("…truncated,", done["output"])


if __name__ == "__main__":
    unittest.main()
