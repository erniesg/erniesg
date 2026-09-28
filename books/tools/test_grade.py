"""grade.summarize: one readable line from a failing tier.

    python3 -m unittest discover -s books/tools -p 'test_*.py'
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import grade

TESTS = grade.CHALLENGES / "max-pairwise-product" / "tests"


def failing(source_line: str, error: str, frames: str = "") -> str:
    return (
        "F\n" + "=" * 70 + "\nFAIL: test_x (__main__.T.test_x)\n" + "-" * 70 +
        "\nTraceback (most recent call last):\n"
        '  File "/x/challenges/max-pairwise-product/tests/public.py", line 13, in test_x\n'
        f"    {source_line}\n    ~~~~^^^^\n{frames}{error}\n\n" + "-" * 70 +
        "\nRan 1 test in 0.001s\n\nFAILED (failures=1)"
    )


class SummarizeTests(unittest.TestCase):
    def test_an_inline_call_names_the_input(self):
        out = failing("self.assertEqual(self.solve([1, 2, 3]), 6)", "AssertionError: 1 != 6")
        self.assertEqual(
            grade.summarize(out, TESTS / "public.py"),
            "max_pairwise_product([1, 2, 3]) returned 1, expected 6",
        )

    def test_a_message_carries_the_input_when_the_call_does_not(self):
        out = failing("self.assertEqual(", "AssertionError: 5 != 25 : disagreement on [5, 5, 1]")
        self.assertEqual(
            grade.summarize(out, TESTS / "stress.py"),
            "max_pairwise_product returned 5, expected 25 — disagreement on [5, 5, 1]",
        )

    def test_an_exception_in_the_readers_code_names_their_line(self):
        out = (
            "E\nTraceback (most recent call last):\n"
            '  File "/x/challenges/max-pairwise-product/tests/public.py", line 13, in test_x\n'
            "    self.assertEqual(self.solve([1, 2, 3]), 6)\n"
            '  File "/x/workspace/max-pairwise-product/pairwise.py", line 16, in max_pairwise_product\n'
            '    raise NotImplementedError("Write me")\n'
            "NotImplementedError: Write me\n"
        )
        self.assertEqual(
            grade.summarize(out, TESTS / "public.py"),
            "your code raised NotImplementedError: Write me on line 16",
        )

    def test_a_timeout_says_it_is_speed(self):
        self.assertTrue(grade.summarize("exceeded the 5s limit").startswith("too slow"))

    def test_nothing_to_say_says_nothing(self):
        self.assertEqual(grade.summarize(""), "")


class HarnessFrameTests(unittest.TestCase):
    """Rule: which frames are the grader's does not depend on the separator."""

    POSIX = (
        "E\nTraceback (most recent call last):\n"
        '  File "/x/books/challenges/max-pairwise-product/tests/public.py", line 13, in test_x\n'
        "    self.assertEqual(self.solve([1, 2, 3]), 6)\n"
        "AssertionError: 1 != 6\n"
    )

    def windows(self, text: str) -> str:
        return text.replace(
            "/x/books/challenges/max-pairwise-product/tests/public.py",
            "C:\\x\\books\\challenges\\max-pairwise-product\\tests\\public.py",
        )

    def test_an_assertion_reads_the_same_on_windows(self):
        posix = grade.summarize(self.POSIX, TESTS / "public.py")
        self.assertEqual(posix, "max_pairwise_product([1, 2, 3]) returned 1, expected 6")
        self.assertEqual(grade.summarize(self.windows(self.POSIX), TESTS / "public.py"), posix)

    def test_every_harness_frame_is_recognised_on_either_separator(self):
        harness = [
            "/x/books/challenges/a/tests/public.py",
            "C:\\x\\books\\challenges\\a\\tests\\public.py",
            "/usr/lib/python3.12/unittest/case.py",
            "C:\\Python312\\Lib\\unittest\\case.py",
            "/x/books/tools/bookgrader.py",
            "C:\\x\\books\\tools\\bookgrader.py",
        ]
        readers = [
            "/x/books/workspace/a/pairwise.py",
            "C:\\x\\books\\workspace\\a\\pairwise.py",
            "/home/me/my_unittest_notes/pairwise.py",
            "/home/me/latests/pairwise.py",
        ]
        for path in harness:
            self.assertTrue(grade.harness_frame(path), path)
        for path in readers:
            self.assertFalse(grade.harness_frame(path), path)


if __name__ == "__main__":
    unittest.main()


OWNER_ATTEMPT = '''def recent(readings, n):
    new_list = []
    for i in range(n):
        print(i)
        if n == 0:
            return []
        else:
            new_list.append(n-1)

    return new_list
'''


class ReaderOutputTests(unittest.TestCase):
    """What the reader printed is kept per call, apart from the runner's noise."""

    def setUp(self):
        import tempfile

        self.node_dir, self.meta = grade.load_node("recent-readings")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.solution = Path(self.tmp.name)

    def write(self, source: str) -> None:
        (self.solution / f"{self.meta['module']}.py").write_text(source)

    def test_prints_are_attributed_to_the_call_that_made_them(self):
        self.write(OWNER_ATTEMPT)
        calls: list[dict] = []
        outcome, output = grade.run_tier(self.node_dir, "public", self.solution, 60, calls=calls)
        self.assertEqual(outcome, "fail")
        self.assertEqual(len(calls), 1, "the tier stops at the first wrong answer")
        first = calls[0]
        self.assertEqual(first["call"], "recent([3, 8, 2, 9, 4], 2)")
        self.assertEqual(first["returned"], "[1, 1]")
        self.assertEqual(first["expected"], "[9, 4]")
        self.assertIs(first["match"], False)
        self.assertEqual(first["out"], "0\n1\n")
        self.assertEqual(first["test"], "test_statement_samples")

    def test_recording_leaves_the_one_line_summary_unchanged(self):
        self.write(OWNER_ATTEMPT)
        calls: list[dict] = []
        _, output = grade.run_tier(self.node_dir, "public", self.solution, 60, calls=calls)
        summary = grade.summarize(output, self.node_dir / "tests" / "public.py")
        self.assertEqual(summary, "recent([3, 8, 2, 9, 4], 2) returned [1, 1], expected [9, 4]")

    def test_a_raise_still_names_the_readers_line_under_recording(self):
        self.write("def recent(readings, n):\n    return readings[n + 100]\n")
        calls: list[dict] = []
        _, output = grade.run_tier(self.node_dir, "public", self.solution, 60, calls=calls)
        summary = grade.summarize(output, self.node_dir / "tests" / "public.py")
        self.assertEqual(summary, "your code raised IndexError: list index out of range on line 2")

    def test_runner_noise_never_lands_in_the_readers_output(self):
        self.write(OWNER_ATTEMPT)
        calls: list[dict] = []
        grade.run_tier(self.node_dir, "public", self.solution, 60, calls=calls)
        for call in calls:
            self.assertNotIn("FAIL", call["out"])
            self.assertNotIn("=" * 10, call["out"])
            self.assertNotRegex(call["out"], r"(?m)^F$")

    def test_a_passing_call_keeps_its_prints_too(self):
        self.write("def recent(readings, n):\n    print('tail', n)\n    return readings[len(readings) - n:] if n else []\n")
        calls: list[dict] = []
        outcome, _ = grade.run_tier(self.node_dir, "public", self.solution, 60, calls=calls)
        self.assertEqual(outcome, "pass")
        self.assertEqual([c["out"] for c in calls], ["tail 2\n", "tail 7\n", "tail 0\n", "tail 5\n"])
        self.assertTrue(all(c["match"] for c in calls))

    def test_a_flood_of_prints_is_truncated_with_a_count(self):
        self.write("def recent(readings, n):\n    for i in range(200_000):\n        print(i)\n    return []\n")
        calls: list[dict] = []
        grade.run_tier(self.node_dir, "public", self.solution, 60, calls=calls)
        self.assertLessEqual(len(calls[0]["out"].encode()), grade.OUTPUT_LIMIT_BYTES)
        self.assertGreater(calls[0]["out_dropped_lines"], 0)

    def test_an_exception_is_recorded_on_its_call(self):
        self.write("def recent(readings, n):\n    print('about to fail')\n    return readings[n + 100]\n")
        calls: list[dict] = []
        grade.run_tier(self.node_dir, "public", self.solution, 60, calls=calls)
        self.assertEqual(calls[0]["out"], "about to fail\n")
        self.assertTrue(calls[0]["raised"].startswith("IndexError"))

    def test_samples_run_every_row_without_grading(self):
        self.write(OWNER_ATTEMPT)
        result = grade.run_samples(self.node_dir, self.solution, 60)
        self.assertEqual(
            [c["call"] for c in result["calls"]],
            ["recent([3, 8, 2, 9, 4], 2)", "recent([3, 8, 2], 7)", "recent([3, 8, 2], 0)", "recent([], 5)"],
        )
        self.assertEqual(result["calls"][1]["out"], "".join(f"{i}\n" for i in range(7)))
        self.assertEqual(result["calls"][2]["out"], "")
        self.assertEqual([c["match"] for c in result["calls"]], [False, False, True, False])

    def test_the_perf_tier_is_never_instrumented(self):
        self.write("def recent(readings, n):\n    return readings[len(readings) - n:] if n else []\n")
        calls: list[dict] = []
        outcome, _ = grade.run_tier(self.node_dir, "perf", self.solution, 60, calls=calls)
        self.assertEqual(outcome, "pass")
        self.assertEqual(calls, [])
