"""Perf tier: a sheet at the size limit.

One pass over 200,000 entries is nothing. Growing the answer with
`result = result + [name]`, or deleting blanks out of the input one at a
time, copies the whole list on every entry and will not finish here.
"""

import time
import unittest

from bookgrader import load_solution

SIZE = 200_000
TIME_LIMIT_SECONDS = 2.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("register").tidy_names

    def test_largest_allowed_sheet(self):
        sheet = []
        for position in range(SIZE):
            sheet.append("   " if position % 3 == 0 else f"  swimmer{position} ")
        expected_kept = SIZE - (SIZE + 2) // 3

        started = time.perf_counter()
        answer = self.solve(sheet)
        elapsed = time.perf_counter() - started

        self.assertEqual(len(answer), expected_kept)
        self.assertEqual(answer[0], "swimmer1")
        self.assertEqual(answer[-1], f"swimmer{SIZE - 1}")
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s",
        )


if __name__ == "__main__":
    unittest.main()
