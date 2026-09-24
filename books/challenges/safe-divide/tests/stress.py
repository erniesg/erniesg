"""Stress tier: against the property every answer must satisfy.

Whatever the split, the parts have to add back up to the bill, and nobody may
be left holding a whole extra share.
"""

import random
import unittest

from bookgrader import load_solution


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("split").split_bill

    def test_small_values_exhaustively(self):
        for cents in range(0, 60):
            for people in range(0, 12):
                each, left = self.solve(cents, people)
                if people == 0:
                    self.assertEqual((each, left), (0, 0), msg=f"{cents} cents, nobody")
                    continue
                self.assertEqual(
                    each * people + left, cents, msg=f"lost money on {cents}/{people}"
                )
                self.assertLess(left, people, msg=f"leftover too big on {cents}/{people}")
                self.assertGreaterEqual(left, 0)

    def test_random_values(self):
        rng = random.Random(20260920)
        for _ in range(800):
            cents = rng.randint(0, 1_000_000)
            people = rng.randint(1, 1000)
            each, left = self.solve(cents, people)
            self.assertEqual(each * people + left, cents)
            self.assertLess(left, people)


if __name__ == "__main__":
    unittest.main()
