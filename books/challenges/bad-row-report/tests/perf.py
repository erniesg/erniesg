"""Perf tier: 200,000 lines, a fifth of them bad.

One pass, appending as you go, is fast. Rebuilding the problems list with
`problems = problems + [...]` on every bad line, or re-summing the good ones
each time round, is not.
"""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 3.0
HOW_MANY = 200_000


def big_file():
    lines = []
    for position in range(HOW_MANY):
        if position % 5 == 0:
            lines.append("not a number")
        else:
            lines.append(str(position))
    return lines


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("rows").parse_amounts

    def test_two_hundred_thousand_lines(self):
        lines = big_file()
        expected_total = sum(p for p in range(HOW_MANY) if p % 5)
        expected_bad = HOW_MANY // 5

        started = time.perf_counter()
        total, problems = self.solve(lines)
        elapsed = time.perf_counter() - started

        self.assertEqual(total, expected_total)
        self.assertEqual(len(problems), expected_bad)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s for {HOW_MANY} lines",
        )


if __name__ == "__main__":
    unittest.main()
