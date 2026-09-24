"""Stress tier: your code against an obvious slow referee on random lists.

The referee is written here in the test, so it stays trustworthy no matter
what you do in your own file. On a disagreement the failing list is printed;
it is deliberately small enough to read.
"""

import random
import unittest

from bookgrader import load_solution

ROUNDS = 400


def referee(numbers: list[int]) -> int:
    best = None
    for i in range(len(numbers)):
        for j in range(i + 1, len(numbers)):
            product = numbers[i] * numbers[j]
            if best is None or product > best:
                best = product
    return best


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("pairwise").max_pairwise_product

    def test_tiny_lists_with_many_repeats(self):
        # Small values force repeated numbers to appear quickly, which is
        # where the common wrong answer breaks.
        rng = random.Random(20260920)
        for _ in range(ROUNDS):
            numbers = [rng.randint(0, 3) for _ in range(rng.randint(2, 4))]
            self.assertEqual(
                self.solve(list(numbers)),
                referee(numbers),
                msg=f"disagreement on {numbers}",
            )

    def test_wider_lists(self):
        rng = random.Random(77)
        for _ in range(ROUNDS):
            numbers = [rng.randint(0, 200_000) for _ in range(rng.randint(2, 60))]
            self.assertEqual(
                self.solve(list(numbers)),
                referee(numbers),
                msg=f"disagreement on {numbers}",
            )


if __name__ == "__main__":
    unittest.main()
