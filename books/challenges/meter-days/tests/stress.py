"""Stress tier: your arithmetic against a meter that really does tick over daily.

The referee lives through one day at a time. On a small credit that is a few
dozen steps, and it is too simple to be wrong. On a disagreement it prints the
credit and the pattern.
"""

import itertools
import random
import unittest

from bookgrader import load_solution


def referee(credit: int, usage: list[int]) -> int:
    if sum(usage) == 0:
        return -1
    days = 0
    today = 0
    while credit >= usage[today]:
        credit -= usage[today]
        days += 1
        today = (today + 1) % len(usage)
    return days


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("meter").days_of_credit

    def test_small_meters_exhaustively(self):
        # Patterns of one, two and three days over the values 0..3, against
        # every credit up to 15. Free days and exact fits both appear early.
        for length in (1, 2, 3):
            for usage in itertools.product(range(0, 4), repeat=length):
                usage = list(usage)
                for credit in range(0, 16):
                    self.assertEqual(
                        self.solve(credit, list(usage)),
                        referee(credit, usage),
                        msg=f"disagreement on credit {credit}, usage {usage}",
                    )

    def test_random_meters(self):
        rng = random.Random(20260920)
        for _ in range(300):
            usage = [rng.randint(0, 4) for _ in range(rng.randint(1, 6))]
            credit = rng.randint(0, 800)
            self.assertEqual(
                self.solve(credit, list(usage)),
                referee(credit, usage),
                msg=f"disagreement on credit {credit}, usage {usage}",
            )

    def test_one_more_day_is_always_too_many(self):
        # Whatever the method, the answer has to sit on the boundary: the days
        # it claims must be affordable, and one more must not be.
        rng = random.Random(77)
        for _ in range(300):
            usage = [rng.randint(0, 5) for _ in range(rng.randint(1, 7))]
            credit = rng.randint(0, 1_000)
            days = self.solve(credit, list(usage))
            if sum(usage) == 0:
                self.assertEqual(days, -1, msg=f"credit {credit}, usage {usage}")
                continue
            spent = sum(usage[day % len(usage)] for day in range(days))
            self.assertLessEqual(spent, credit, msg=f"credit {credit}, usage {usage}")
            spent += usage[days % len(usage)]
            self.assertGreater(spent, credit, msg=f"credit {credit}, usage {usage}")


if __name__ == "__main__":
    unittest.main()
