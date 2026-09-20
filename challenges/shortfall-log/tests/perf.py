"""Perf tier: a hundred thousand nights, half of them short.

`log = log + [entry]` rebuilds the whole log on every short night. That is
about a billion and a quarter entries copied here, and it is the only common
way to fail this tier.
"""

import time
import unittest

from bookgrader import load_solution

NIGHTS = 100_000
TARGET = 180
TIME_LIMIT_SECONDS = 2.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shortfall").log_shortfalls

    def test_a_hundred_thousand_nights(self):
        served = [night % 360 for night in range(NIGHTS)]
        expected = [
            (night, TARGET - meals) for night, meals in enumerate(served) if meals < TARGET
        ]

        started = time.perf_counter()
        entries = self.solve(served, TARGET)
        elapsed = time.perf_counter() - started

        self.assertEqual(len(entries), len(expected))
        self.assertEqual(entries, expected)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s — "
            f"append to the log instead of rebuilding it each night",
        )

    def test_every_night_short(self):
        served = [0] * NIGHTS

        started = time.perf_counter()
        entries = self.solve(served, TARGET)
        elapsed = time.perf_counter() - started

        self.assertEqual(len(entries), NIGHTS)
        self.assertEqual(entries[0], (0, TARGET))
        self.assertEqual(entries[-1], (NIGHTS - 1, TARGET))
        self.assertLess(elapsed, TIME_LIMIT_SECONDS, msg=f"took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
