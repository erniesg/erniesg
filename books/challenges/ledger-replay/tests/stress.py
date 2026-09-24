"""Stress tier: a referee that re-adds the whole day on every entry.

It keeps the accepted entries in a list and totals them from scratch each time,
which nobody would ship and nobody can get wrong. Also checks the one promise
the card makes: the balance is never below zero, at any point.
"""

import random
import unittest
from itertools import product

from bookgrader import load_solution


def reference(amounts):
    """The same rules, re-adding everything accepted so far, every time."""
    accepted = []
    rejected = []
    for position, amount in enumerate(amounts):
        balance = sum(accepted)
        if amount < 0 and balance + amount < 0:
            rejected.append(position)
        else:
            accepted.append(amount)
    return (sum(accepted), rejected)


def balance_after_each_entry(amounts, rejected):
    """Replay the day, skipping the refused entries, and report every balance."""
    refused = set(rejected)
    balance = 0
    seen = []
    for position, amount in enumerate(amounts):
        if position not in refused:
            balance += amount
        seen.append(balance)
    return balance, seen


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("ledger").replay

    def test_every_short_day_exhaustively(self):
        choices = [-3, -1, 0, 1, 2]
        for length in range(0, 4):
            for amounts in product(choices, repeat=length):
                amounts = list(amounts)
                self.assertEqual(
                    self.solve(amounts),
                    reference(amounts),
                    msg=f"failed on {amounts}",
                )

    def test_random_days(self):
        rng = random.Random(20260920)
        for _ in range(600):
            length = rng.randint(0, 12)
            amounts = [rng.randint(-6, 5) for _ in range(length)]
            self.assertEqual(
                self.solve(amounts), reference(amounts), msg=f"failed on {amounts}"
            )

    def test_the_balance_is_never_below_zero(self):
        rng = random.Random(555)
        for _ in range(600):
            length = rng.randint(1, 15)
            amounts = [rng.randint(-8, 4) for _ in range(length)]
            balance, rejected = self.solve(amounts)
            replayed, seen = balance_after_each_entry(amounts, rejected)
            self.assertEqual(
                balance,
                replayed,
                msg=f"balance does not match the entries you accepted on {amounts}",
            )
            for position, running in enumerate(seen):
                self.assertGreaterEqual(
                    running,
                    0,
                    msg=f"balance {running} after entry {position} on {amounts}",
                )


if __name__ == "__main__":
    unittest.main()
