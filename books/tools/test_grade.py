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
