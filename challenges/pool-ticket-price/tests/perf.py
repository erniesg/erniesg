"""Perf tier: four comparisons is four comparisons, however old the swimmer.

This only catches a solution that counts up to the age one year at a time.
"""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("ticket").ticket_price

    def test_a_queue_of_swimmers_stays_quick(self):
        started = time.perf_counter()
        for _ in range(50_000):
            self.solve(4)
            self.solve(64)
            self.solve(120)
        elapsed = time.perf_counter() - started
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s — a price lookup should not depend on the age",
        )


if __name__ == "__main__":
    unittest.main()
