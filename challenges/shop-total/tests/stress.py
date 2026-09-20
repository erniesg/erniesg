"""Stress tier: every price and quantity that matters, against plain arithmetic."""

import random
import unittest

from bookgrader import load_solution


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shop").shop_total

    def test_small_values_exhaustively(self):
        for price in range(0, 40):
            for quantity in range(0, 40):
                self.assertEqual(
                    self.solve(str(price), quantity),
                    price * quantity,
                    msg=f"failed on price {price!r}, quantity {quantity}",
                )

    def test_random_values_in_range(self):
        rng = random.Random(20260920)
        for _ in range(500):
            price = rng.randint(0, 1000)
            quantity = rng.randint(0, 1000)
            self.assertEqual(self.solve(str(price), quantity), price * quantity)


if __name__ == "__main__":
    unittest.main()
