"""Perf tier: the worst order the constraints allow, many times over.

A million portions in trays of one. Stacking trays one at a time is a million
times round the loop for a single call, and this makes 50,000 calls.
"""

import time
import unittest

from bookgrader import load_solution

CALLS = 50_000
TIME_LIMIT_SECONDS = 1.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("trays").trays_needed

    def test_many_large_orders(self):
        started = time.perf_counter()
        for _ in range(CALLS):
            answer = self.solve(1_000_000, 1)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, (1_000_000, 0))
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s — "
            f"one division answers this whatever the numbers are",
        )

    def test_the_default_path_is_no_slower(self):
        started = time.perf_counter()
        for _ in range(CALLS):
            answer = self.solve(1_000_000)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, (83_334, 8))
        self.assertLess(elapsed, TIME_LIMIT_SECONDS, msg=f"took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
