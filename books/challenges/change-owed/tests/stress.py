"""Stress tier: against a referee that is obviously right because it is stupid.

The reference counts change up one cent at a time, which nobody would ship and
nobody can get wrong. It is run only on small amounts, where slow is free.
"""

import random
import unittest

from bookgrader import load_solution


def reference(price, paid):
    """The same rules, written the slowest way there is."""
    if not isinstance(price, int) or not isinstance(paid, int):
        raise TypeError("both amounts must be whole numbers")
    if price < 0 or paid < 0:
        raise ValueError("amounts cannot be negative")
    if paid < price:
        raise ValueError("underpaid")
    change = 0
    while price + change < paid:  # hand back one cent, then another, then...
        change += 1
    return change


def outcome(function, price, paid):
    """What happened: a value, or the name of the error raised."""
    try:
        return ("returned", function(price, paid))
    except Exception as problem:
        return ("raised", type(problem).__name__)


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("change").change_owed

    def test_small_amounts_exhaustively(self):
        for price in range(0, 26):
            for paid in range(0, 26):
                self.assertEqual(
                    outcome(self.solve, price, paid),
                    outcome(reference, price, paid),
                    msg=f"failed on price {price!r}, paid {paid!r}",
                )

    def test_random_inputs_including_junk(self):
        rng = random.Random(20260920)
        junk = [-1, -250, 2.5, 500.0, "250", "", None, [250]]
        for _ in range(600):
            price = rng.choice(junk) if rng.random() < 0.3 else rng.randint(0, 25)
            paid = rng.choice(junk) if rng.random() < 0.3 else rng.randint(0, 25)
            self.assertEqual(
                outcome(self.solve, price, paid),
                outcome(reference, price, paid),
                msg=f"failed on price {price!r}, paid {paid!r}",
            )

    def test_large_valid_amounts_keep_the_promise(self):
        # Too big to count up to, so check the property instead: the change
        # handed back has to top the price up to exactly what was paid.
        rng = random.Random(1234)
        for _ in range(500):
            price = rng.randint(0, 1_000_000)
            paid = rng.randint(price, 1_000_000)
            change = self.solve(price, paid)
            self.assertEqual(
                price + change, paid, msg=f"failed on price {price}, paid {paid}"
            )
            self.assertGreaterEqual(
                change, 0, msg=f"negative change on price {price}, paid {paid}"
            )


if __name__ == "__main__":
    unittest.main()
