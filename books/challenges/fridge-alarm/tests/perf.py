"""Perf tier: the box asks this once a minute, forever. Five comparisons is plenty."""

import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("fridge").fridge_message

    def test_a_year_of_readings_is_instant(self):
        started = time.perf_counter()
        for minute in range(200_000):
            self.solve(5, minute % 12, True)
        elapsed = time.perf_counter() - started
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s — nothing here should depend on the door minutes",
        )


if __name__ == "__main__":
    unittest.main()
