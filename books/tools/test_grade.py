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

    def test_one_huge_write_is_bounded_as_it_arrives(self):
        import bookgrader

        buffer = bookgrader._BoundedBuffer()
        buffer.write("x" * 5_000_000 + "\n" + "y\n" * 10)
        self.assertLessEqual(len(buffer.getvalue().encode()), grade.OUTPUT_LIMIT_BYTES + 1)
        self.assertEqual(buffer.dropped_lines, 11)

    def test_samples_that_expect_a_raise_see_it_and_every_row_runs(self):
        node_dir, meta = grade.load_node("change-owed")
        solution = Path(self.tmp.name) / "change"
        solution.mkdir()
        (solution / f"{meta['module']}.py").write_text(
            (node_dir / "solution.py").read_text())
        result = grade.run_samples(node_dir, solution, 60)
        raising = [c for c in result["calls"] if "raised" in c]
        self.assertEqual(len(raising), 4, "both wrong-kind rows run, not just the first")
        self.assertTrue(all(c["match"] is True for c in raising))
        self.assertTrue(all(c["expected"].startswith("raises ") for c in raising))

    def test_a_missing_raise_is_a_wrong_answer(self):
        node_dir, meta = grade.load_node("change-owed")
        solution = Path(self.tmp.name) / "change"
        solution.mkdir()
        (solution / f"{meta['module']}.py").write_text("def change_owed(price, paid):\n    return paid - price\n")
        result = grade.run_samples(node_dir, solution, 60)
        underpaid = next(c for c in result["calls"] if c["call"] == "change_owed(250, 200)")
        self.assertIs(underpaid["match"], False)
        self.assertEqual(underpaid["expected"], "raises ValueError")

    def test_a_none_sample_gets_a_verdict(self):
        node_dir, meta = grade.load_node("parse-setting")
        solution = Path(self.tmp.name) / "setting"
        solution.mkdir()
        (solution / f"{meta['module']}.py").write_text((node_dir / "solution.py").read_text())
        result = grade.run_samples(node_dir, solution, 60)
        nones = [c for c in result["calls"] if c.get("expected") == "None"]
        self.assertEqual(len(nones), 2)
        self.assertTrue(all(c["match"] is True for c in nones))

    def test_the_wrong_call_is_kept_even_in_the_middle_of_a_long_tier(self):
        # wrong only on n == 3 of a long log: many right calls before and after
        self.write(
            "def recent(readings, n):\n"
            "    if n == 3 and len(readings) == 6:\n        return ['wrong']\n"
            "    return readings[-n:] if n else []\n")
        calls: list[dict] = []
        outcome, _ = grade.run_tier(self.node_dir, "stress", self.solution, 60, calls=calls)
        self.assertEqual(outcome, "fail")
        self.assertTrue(any(c.get("match") is False and c["returned"] == "['wrong']" for c in calls))

    def reference(self, node_id: str) -> tuple[Path, Path]:
        node_dir, meta = grade.load_node(node_id)
        solution = Path(self.tmp.name) / node_id
        solution.mkdir()
        (solution / f"{meta['module']}.py").write_text((node_dir / "solution.py").read_text())
        return node_dir, solution

    def test_an_expected_raise_is_green_on_a_correct_solution(self):
        node_dir, solution = self.reference("bad-row-report")
        calls: list[dict] = []
        outcome, _ = grade.run_tier(node_dir, "public", solution, 60, calls=calls)
        self.assertEqual(outcome, "pass")
        raised = [c for c in calls if "raised" in c]
        self.assertEqual(len(raised), 1)
        self.assertIs(raised[0]["match"], True)
        self.assertEqual(raised[0]["expected"], "raises TypeError")

    def test_a_wrong_kind_of_raise_is_recorded_and_every_row_still_runs(self):
        node_dir, meta = grade.load_node("change-owed")
        solution = Path(self.tmp.name) / "wrong-kind"
        solution.mkdir()
        (solution / f"{meta['module']}.py").write_text(
            "def change_owed(price, paid):\n"
            "    if not isinstance(price, int) or not isinstance(paid, int):\n"
            "        raise RuntimeError('bad kind')\n"
            "    if paid < 0 or paid < price:\n        raise ValueError('no')\n"
            "    return paid - price\n")
        result = grade.run_samples(node_dir, solution, 60)
        kinds = [c for c in result["calls"] if c.get("expected") == "raises TypeError"]
        self.assertEqual(len(kinds), 2, "both wrong-kind rows ran")
        self.assertTrue(all(c["match"] is False for c in kinds))

    def test_a_postcondition_failure_marks_the_call_that_broke_it(self):
        node_dir, meta = grade.load_node("buy-low-sell-later")
        solution = Path(self.tmp.name) / "mutates"
        solution.mkdir()
        source = (node_dir / "solution.py").read_text()
        function = "best_gain"
        (solution / f"{meta['module']}.py").write_text(
            source + f"\n\n_original = {function}\n\ndef {function}(prices, *rest):\n"
            "    answer = _original(prices, *rest)\n    prices.sort()\n    return answer\n")
        calls: list[dict] = []
        outcome, _ = grade.run_tier(node_dir, "edge", solution, 60, calls=calls)
        self.assertEqual(outcome, "fail")
        self.assertTrue(any(c.get("match") is False for c in calls))

    def test_an_isinstance_failure_overrides_an_earlier_pass(self):
        node_dir, meta = grade.load_node("pool-ticket-price")
        solution = Path(self.tmp.name) / "floats"
        solution.mkdir()
        (solution / f"{meta['module']}.py").write_text(
            (node_dir / "solution.py").read_text()
            + "\n\n_int_price = ticket_price\n\ndef ticket_price(age):\n    return float(_int_price(age))\n")
        calls: list[dict] = []
        outcome, _ = grade.run_tier(node_dir, "edge", solution, 60, calls=calls)
        self.assertEqual(outcome, "fail")
        self.assertTrue(any(c.get("match") is False and "instance" in c.get("expected", "") for c in calls))

    def test_the_true_number_of_calls_survives_the_cap(self):
        self.write("def recent(readings, n):\n    return readings[-n:] if n else []\n")
        calls: list[dict] = []
        counts: dict = {}
        grade.run_tier(self.node_dir, "stress", self.solution, 60, calls=calls, counts=counts)
        self.assertGreater(counts["total"], len(calls))

    def test_sys_exit_in_the_readers_code_is_recorded_with_its_prints(self):
        self.write("import sys\n\ndef recent(readings, n):\n    print('leaving')\n    sys.exit(3)\n")
        calls: list[dict] = []
        outcome, _ = grade.run_tier(self.node_dir, "public", self.solution, 60, calls=calls)
        self.assertEqual(outcome, "fail")
        self.assertEqual(calls[0]["out"], "leaving\n")
        self.assertTrue(calls[0]["raised"].startswith("SystemExit"))

    def test_an_imported_or_partial_function_is_still_recorded(self):
        self.write(
            "import functools\n\ndef _tail(readings, n, *, keep):\n"
            "    return readings[-n:] if n else []\n\n"
            "recent = functools.partial(_tail, keep=True)\n")
        calls: list[dict] = []
        outcome, _ = grade.run_tier(self.node_dir, "public", self.solution, 60, calls=calls)
        self.assertEqual(outcome, "pass")
        self.assertEqual(len(calls), 4)
        self.assertTrue(calls[0]["call"].startswith("recent("))

    def test_the_perf_tier_is_never_instrumented(self):
        self.write("def recent(readings, n):\n    return readings[len(readings) - n:] if n else []\n")
        calls: list[dict] = []
        outcome, _ = grade.run_tier(self.node_dir, "perf", self.solution, 60, calls=calls)
        self.assertEqual(outcome, "pass")
        self.assertEqual(calls, [])
