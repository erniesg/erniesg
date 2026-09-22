"""Stress tier: every legal age, against an obviously-correct band table.

The referee does not try to be clever. It holds the four bands exactly as the
sign on the door writes them, and for each age it hands back the first band
that contains it.
"""

import unittest

from bookgrader import load_solution

BANDS = [
    (0, 4, 0),
    (5, 17, 350),
    (18, 64, 620),
    (65, 120, 400),
]


def referee(age):
    for low, high, price in BANDS:
        if low <= age <= high:
            return price
    raise AssertionError(f"the band table itself has a hole at {age}")


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("ticket").ticket_price

    def test_every_age_exhaustively(self):
        for age in range(0, 121):
            self.assertEqual(
                self.solve(age),
                referee(age),
                msg=f"failed on age {age}",
            )

    def test_the_price_changes_exactly_three_times(self):
        """Four bands means three steps, and they sit at 5, 18 and 65."""
        steps = [age for age in range(1, 121) if self.solve(age) != self.solve(age - 1)]
        self.assertEqual(
            steps,
            [5, 18, 65],
            msg=f"the price changes at {steps}, but the door says 5, 18 and 65",
        )


if __name__ == "__main__":
    unittest.main()
