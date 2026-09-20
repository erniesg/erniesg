"""Perf tier: nothing here can be slow, so this only guards against silliness."""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("digits").sum_of_two_digits

    def test_many_calls_stay_quick(self):
        started = time.perf_counter()
        for _ in range(100_000):
            self.solve(9, 7)
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, TIME_LIMIT_SECONDS, msg=f"took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
