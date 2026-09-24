"""Perf tier: subtraction is instant; counting up one cent at a time is not."""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("change").change_owed

    def test_a_million_cents_of_change_is_instant(self):
        started = time.perf_counter()
        for _ in range(2_000):
            self.solve(0, 1_000_000)
        elapsed = time.perf_counter() - started
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s — handing back one cent at a time will not pass",
        )

    def test_raising_is_not_slower_than_returning(self):
        started = time.perf_counter()
        for _ in range(2_000):
            try:
                self.solve(1_000_000, 0)
            except ValueError:
                pass
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, TIME_LIMIT_SECONDS, msg=f"took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
