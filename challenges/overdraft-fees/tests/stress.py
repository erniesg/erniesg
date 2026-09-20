"""Stress tier: your one pass against an obvious slow referee.

The referee rebuilds every balance from scratch out of a slice of the
payments. It is far too slow to submit and far too simple to be wrong, which
is exactly what a referee is for. On a disagreement it prints the start and
the payments, both small enough to read.
"""

import itertools
import random
import unittest

from bookgrader import load_solution

CHARGE = 800


def referee(start: int, payments: list[int]) -> tuple[int, int]:
    balances = [start - sum(payments[:count]) for count in range(len(payments) + 1)]
    charged = CHARGE * sum(1 for balance in balances[1:] if balance < 0)
    return (charged, min(balances))


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("overdraft").overdraft_cost

    def test_every_short_month_exhaustively(self):
        # Small starts and small payments mean zero balances and repeated dips
        # both turn up within the first few cases.
        for start in range(0, 5):
            for length in range(0, 4):
                for payments in itertools.product(range(0, 4), repeat=length):
                    payments = list(payments)
                    self.assertEqual(
                        self.solve(start, list(payments)),
                        referee(start, payments),
                        msg=f"disagreement on start {start}, payments {payments}",
                    )

    def test_random_months(self):
        rng = random.Random(20260920)
        for _ in range(400):
            start = rng.randint(0, 20_000)
            payments = [rng.randint(0, 6_000) for _ in range(rng.randint(0, 25))]
            self.assertEqual(
                self.solve(start, list(payments)),
                referee(start, payments),
                msg=f"disagreement on start {start}, payments {payments}",
            )

    def test_the_answer_always_holds_together(self):
        # Two things must be true of any answer, whatever method produced it:
        # the charge is a whole number of 800s, and the lowest balance is one
        # of the balances the account actually passed through.
        rng = random.Random(77)
        for _ in range(400):
            start = rng.randint(0, 5_000)
            payments = [rng.randint(0, 900) for _ in range(rng.randint(0, 15))]
            charged, lowest = self.solve(start, list(payments))
            reached = [start]
            running = start
            for payment in payments:
                running -= payment
                reached.append(running)
            self.assertEqual(charged % CHARGE, 0, msg=f"start {start}, payments {payments}")
            self.assertIn(lowest, reached, msg=f"start {start}, payments {payments}")
            self.assertEqual(lowest, min(reached), msg=f"start {start}, payments {payments}")


if __name__ == "__main__":
    unittest.main()
