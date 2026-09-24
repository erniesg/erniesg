"""Perf tier: four months of readings, at the size limit.

One pass over 200,000 readings takes a few thousandths of a second. Every buy
against every later sell is 20 billion comparisons — ten minutes measured, and
the ten-million rule says worse — so the tier stops it at three.
"""

import random
import time
import unittest

from bookgrader import load_solution

SIZE = 200_000
TIME_LIMIT_SECONDS = 3.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("resale").best_gain

    def test_largest_allowed_log(self):
        rng = random.Random(4242)
        prices = [rng.randint(400_000, 600_000) for _ in range(SIZE)]
        prices[17] = 0                    # the cheapest minute, early on
        prices[SIZE - 9] = 1_000_000      # the dearest minute, later
        prices[SIZE - 1] = 0              # and it falls back at the end

        started = time.perf_counter()
        answer = self.solve(prices)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, 1_000_000)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s — "
            f"an every-pair answer cannot pass here",
        )


if __name__ == "__main__":
    unittest.main()
