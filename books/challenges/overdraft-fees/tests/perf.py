"""Perf tier: one month at the size limit.

Rebuilding the balance from `sum(payments[:i])` each time round is correct and
cannot finish this.
"""

import random
import time
import unittest

from bookgrader import load_solution

SIZE = 100_000
TIME_LIMIT_SECONDS = 2.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("overdraft").overdraft_cost

    def test_largest_allowed_month(self):
        rng = random.Random(4242)
        payments = [rng.randint(0, 20) for _ in range(SIZE)]
        start = 100_000

        running = start
        lowest = start
        charged = 0
        for payment in payments:
            running -= payment
            lowest = min(lowest, running)
            charged += 800 if running < 0 else 0

        started = time.perf_counter()
        answer = self.solve(start, payments)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, (charged, lowest))
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s — "
            f"carry a running balance instead of re-adding the payments so far",
        )


if __name__ == "__main__":
    unittest.main()
