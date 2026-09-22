"""Perf tier: nothing here is slow, so this only catches something silly."""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shop").shop_total

    def test_many_calls_stay_quick(self):
        started = time.perf_counter()
        for _ in range(100_000):
            self.solve("25", 4)
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, TIME_LIMIT_SECONDS, msg=f"took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
