"""Stress tier: your loop against an obviously-correct one-liner.

The referee builds the same log with a comprehension, which is too short to
hide a mistake in. On a disagreement it prints the nights and the target.
"""

import itertools
import random
import unittest

from bookgrader import load_solution


def referee(served: list[int], target: int) -> list[tuple[int, int]]:
    return [(night, target - meals) for night, meals in enumerate(served) if meals < target]


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("shortfall").log_shortfalls

    def test_short_months_exhaustively(self):
        # Every month of up to three nights over the values 0..3, against every
        # target in range. Repeated values and exact hits both turn up at once.
        for length in range(0, 4):
            for served in itertools.product(range(0, 4), repeat=length):
                served = list(served)
                for target in range(1, 5):
                    self.assertEqual(
                        self.solve(list(served), target),
                        referee(served, target),
                        msg=f"disagreement on served {served}, target {target}",
                    )

    def test_random_months(self):
        rng = random.Random(20260920)
        for _ in range(400):
            served = [rng.randint(0, 250) for _ in range(rng.randint(0, 20))]
            target = rng.randint(1, 250)
            self.assertEqual(
                self.solve(list(served), target),
                referee(served, target),
                msg=f"disagreement on served {served}, target {target}",
            )

    def test_a_passed_log_is_extended_never_replaced(self):
        rng = random.Random(77)
        for _ in range(400):
            served = [rng.randint(0, 250) for _ in range(rng.randint(0, 20))]
            target = rng.randint(1, 250)
            already = [(-1, 1), (-2, 2)]
            given = list(already)
            returned = self.solve(list(served), target, given)
            where = f"served {served}, target {target}"
            self.assertIs(returned, given, msg=f"not the caller's list on {where}")
            self.assertEqual(returned, already + referee(served, target), msg=where)

    def test_the_answer_always_holds_together(self):
        # Whatever the method: one entry per night below target, in order, and
        # every shortfall a positive number that lands back on the night's count.
        rng = random.Random(4242)
        for _ in range(400):
            served = [rng.randint(0, 250) for _ in range(rng.randint(0, 30))]
            target = rng.randint(1, 250)
            entries = self.solve(list(served), target)
            where = f"served {served}, target {target}"
            nights = [night for night, _ in entries]
            self.assertEqual(nights, sorted(set(nights)), msg=f"out of order on {where}")
            self.assertEqual(
                len(entries),
                sum(1 for meals in served if meals < target),
                msg=f"wrong number of short nights on {where}",
            )
            for night, short in entries:
                self.assertGreater(short, 0, msg=f"night {night} on {where}")
                self.assertEqual(served[night] + short, target, msg=f"night {night} on {where}")


if __name__ == "__main__":
    unittest.main()
