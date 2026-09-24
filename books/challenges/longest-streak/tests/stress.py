"""Stress tier: against a referee that tries every span of days.

Checking all of them is hopeless on a real list and unbeatable on a short one,
which is exactly what a referee should be.
"""

import random
import unittest
from itertools import product

from bookgrader import load_solution


def reference(days):
    """Try every stretch of days and keep the longest all-True one."""
    best = 0
    for start in range(len(days)):
        for end in range(start, len(days)):
            stretch = days[start : end + 1]
            if all(stretch):
                best = max(best, len(stretch))
    return best


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("streak").longest_streak

    def test_every_list_up_to_ten_days(self):
        # 2 + 4 + ... + 1024 lists. All of them, no guessing.
        for length in range(0, 11):
            for days in product([True, False], repeat=length):
                days = list(days)
                self.assertEqual(
                    self.solve(days),
                    reference(days),
                    msg=f"failed on {days}",
                )

    def test_random_longer_lists(self):
        rng = random.Random(20260920)
        for _ in range(300):
            length = rng.randint(0, 40)
            # Lean towards True so long runs, and runs that reach the end,
            # show up often rather than once in a blue moon.
            days = [rng.random() < 0.7 for _ in range(length)]
            self.assertEqual(
                self.solve(days), reference(days), msg=f"failed on {days}"
            )


if __name__ == "__main__":
    unittest.main()
