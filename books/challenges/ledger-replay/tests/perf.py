"""Perf tier: 200,000 entries.

Re-adding the accepted entries on every step is correct and hopeless. Keep the
running balance in a name.
"""

import random
import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.5
HOW_MANY = 200_000


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("ledger").replay

    def test_two_hundred_thousand_entries(self):
        rng = random.Random(4242)
        amounts = [rng.randint(-200, 210) for _ in range(HOW_MANY)]

        started = time.perf_counter()
        balance, rejected = self.solve(amounts)
        elapsed = time.perf_counter() - started

        self.assertGreaterEqual(balance, 0)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s for {HOW_MANY} entries",
        )

    def test_a_day_of_nothing_but_refusals(self):
        amounts = [-1] * HOW_MANY
        started = time.perf_counter()
        balance, rejected = self.solve(amounts)
        elapsed = time.perf_counter() - started
        self.assertEqual(balance, 0)
        self.assertEqual(len(rejected), HOW_MANY)
        self.assertLess(elapsed, TIME_LIMIT_SECONDS, msg=f"took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
