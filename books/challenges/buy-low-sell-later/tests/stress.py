"""Stress tier: against the every-pair version, on tiny lists.

The referee below is the answer you were told not to write: try every buy
against every later sell. On five readings that is ten pairs and costs
nothing, and it cannot be wrong. Prices are drawn from a small range so that
repeats, flat runs and highs-before-lows all turn up within a few tries.
"""

import random
import unittest

from bookgrader import load_solution


def every_pair(prices):
    best = 0
    for buy in range(len(prices)):
        for sell in range(buy + 1, len(prices)):
            if prices[sell] - prices[buy] > best:
                best = prices[sell] - prices[buy]
    return best


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("resale").best_gain

    def test_random_tiny_lists(self):
        rng = random.Random(20260920)
        for _ in range(1500):
            prices = [rng.randint(0, 5) for _ in range(rng.randint(0, 5))]
            self.assertEqual(
                self.solve(list(prices)),
                every_pair(prices),
                msg=f"wrong answer for {prices!r}",
            )

    def test_every_list_of_four_from_three_prices(self):
        for a in range(3):
            for b in range(3):
                for c in range(3):
                    for d in range(3):
                        prices = [a, b, c, d]
                        self.assertEqual(
                            self.solve(list(prices)),
                            every_pair(prices),
                            msg=f"wrong answer for {prices!r}",
                        )

    def test_longer_random_lists(self):
        rng = random.Random(4242)
        for _ in range(60):
            prices = [rng.randint(0, 1_000_000) for _ in range(rng.randint(2, 120))]
            self.assertEqual(
                self.solve(list(prices)),
                every_pair(prices),
                msg=f"wrong answer for {prices!r}",
            )


if __name__ == "__main__":
    unittest.main()
