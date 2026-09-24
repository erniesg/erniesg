"""Stress tier: your arithmetic against a referee that stacks trays one at a time.

The referee adds trays until there is enough, which is too slow to submit and
too simple to be wrong. On a disagreement it prints the portions and the tray
size.
"""

import random
import unittest

from bookgrader import load_solution


def referee(portions: int, per_tray: int) -> tuple[int, int]:
    trays = 0
    brought = 0
    while brought < portions:
        trays += 1
        brought += per_tray
    return (trays, brought - portions)


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("trays").trays_needed

    def test_small_orders_exhaustively(self):
        for per_tray in range(1, 13):
            for portions in range(0, 61):
                self.assertEqual(
                    self.solve(portions, per_tray),
                    referee(portions, per_tray),
                    msg=f"disagreement on {portions} portions, trays of {per_tray}",
                )

    def test_random_orders(self):
        rng = random.Random(20260920)
        for _ in range(500):
            portions = rng.randint(0, 3_000)
            per_tray = rng.randint(1, 60)
            self.assertEqual(
                self.solve(portions, per_tray),
                referee(portions, per_tray),
                msg=f"disagreement on {portions} portions, trays of {per_tray}",
            )

    def test_the_answer_always_holds_together(self):
        # Three things must be true of any answer: the trays feed everyone,
        # one tray fewer does not, and the spare is what is left in the last.
        rng = random.Random(77)
        for _ in range(500):
            portions = rng.randint(0, 1_000_000)
            per_tray = rng.randint(1, 1_000)
            trays, spare = self.solve(portions, per_tray)
            where = f"{portions} portions, trays of {per_tray}"
            self.assertGreaterEqual(trays * per_tray, portions, msg=f"short on {where}")
            self.assertEqual(spare, trays * per_tray - portions, msg=f"spare wrong on {where}")
            self.assertGreaterEqual(spare, 0, msg=f"negative spare on {where}")
            self.assertLess(spare, per_tray, msg=f"a whole tray spare on {where}")
            if portions > 0:
                self.assertLess((trays - 1) * per_tray, portions, msg=f"a tray too many on {where}")


if __name__ == "__main__":
    unittest.main()
