"""Perf tier: the screen refreshes constantly, and the log only gets longer.

Taking the tail costs `n`. Copying the whole log first costs 200,000, every
single time, and that is what this notices.
"""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.0
CALLS = 8000


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("recent").recent

    def test_refreshing_a_small_screen_off_a_long_log(self):
        log = list(range(200_000))
        started = time.perf_counter()
        for _ in range(CALLS):
            self.solve(log, 5)
        elapsed = time.perf_counter() - started
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=(
                f"took {elapsed:.2f}s for {CALLS} refreshes — "
                f"the cost should follow the screen, not the log"
            ),
        )


if __name__ == "__main__":
    unittest.main()
