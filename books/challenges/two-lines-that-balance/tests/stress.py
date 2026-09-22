"""Stress tier: against the every-pair version, on tiny files.

The referee below is the answer you were told not to write: for each line, try
every line above it. On six lines that is fifteen pairs and costs nothing, and
it cannot be wrong. Amounts are drawn from a small range so that repeats,
self-pairing traps and negatives all turn up within a few tries.
"""

import random
import unittest

from bookgrader import load_solution


def every_pair(amounts, target):
    for later in range(len(amounts)):
        for earlier in range(later):
            if amounts[earlier] + amounts[later] == target:
                return later
    return -1


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("balance").first_balancing_line

    def test_random_tiny_files(self):
        rng = random.Random(20260920)
        for _ in range(3000):
            amounts = [rng.randint(-3, 3) for _ in range(rng.randint(0, 6))]
            target = rng.randint(-6, 6)
            self.assertEqual(
                self.solve(list(amounts), target),
                every_pair(amounts, target),
                msg=f"wrong answer for {amounts!r} against {target}",
            )

    def test_every_file_of_four_from_three_amounts(self):
        for a in range(3):
            for b in range(3):
                for c in range(3):
                    for d in range(3):
                        amounts = [a, b, c, d]
                        for target in range(0, 5):
                            self.assertEqual(
                                self.solve(list(amounts), target),
                                every_pair(amounts, target),
                                msg=f"wrong answer for {amounts!r} against {target}",
                            )

    def test_longer_random_files(self):
        rng = random.Random(4242)
        for _ in range(60):
            amounts = [rng.randint(-50, 50) for _ in range(rng.randint(2, 120))]
            target = rng.randint(-100, 100)
            self.assertEqual(
                self.solve(list(amounts), target),
                every_pair(amounts, target),
                msg=f"wrong answer for {amounts!r} against {target}",
            )


if __name__ == "__main__":
    unittest.main()
