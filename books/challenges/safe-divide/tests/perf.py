"""Perf tier: arithmetic should not be slow; this catches a loop where none belongs."""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("split").split_bill

    def test_large_values_are_instant(self):
        started = time.perf_counter()
        for _ in range(100_000):
            self.solve(1_000_000, 999)
        elapsed = time.perf_counter() - started
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s — counting up one at a time will not pass here",
        )


if __name__ == "__main__":
    unittest.main()
