"""Perf tier: a billion units of credit, a thousand-day pattern.

A loop that lives through one day at a time is correct and needs about a
billion times round. This tier is that input, and nothing else.
"""

import bisect
import itertools
import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("meter").days_of_credit

    def test_a_billion_days(self):
        usage = [1] * 1000

        started = time.perf_counter()
        exact = self.solve(1_000_000_000, usage)
        part_way = self.solve(999_999_999, usage)
        elapsed = time.perf_counter() - started

        self.assertEqual(exact, 1_000_000_000)
        self.assertEqual(part_way, 999_999_999)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s — "
            f"one trip through the pattern always costs the same",
        )

    def test_a_heavy_pattern_with_a_remainder(self):
        # The leftover does not land on a trip boundary here, so the answer is
        # only right if the short walk at the end is right too.
        usage = [index % 7 for index in range(1000)]
        credit = 1_000_000_000

        started = time.perf_counter()
        answer = self.solve(credit, usage)
        elapsed = time.perf_counter() - started

        # Worked out a different way: the running cost of the first k days of a
        # trip, then the last k whose cost the credit still covers.
        spent_by_day = list(itertools.accumulate(usage))
        cycle = spent_by_day[-1]
        trips, left = divmod(credit, cycle)
        expected = trips * len(usage) + bisect.bisect_right(spent_by_day, left)

        self.assertEqual(answer, expected)
        self.assertLess(elapsed, TIME_LIMIT_SECONDS, msg=f"took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
