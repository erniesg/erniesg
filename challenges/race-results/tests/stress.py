"""Stress tier: against a referee that reads the order out by hand.

The referee below picks the best remaining swimmer, writes the name down, and
crosses that swimmer off. It is slow and it is obviously right, which is the
deal. Races here hold at most six swimmers, drawn from four names and three
times, so ties appear almost immediately.
"""

import random
import unittest

from bookgrader import load_solution

NAMES = ["ada", "bob", "mia", "sam"]
TIMES = [20, 30, 40]


def obviously_correct(names, seconds):
    remaining = list(zip(names, seconds))
    order = []
    while remaining:
        best = 0
        for position in range(1, len(remaining)):
            here, champion = remaining[position], remaining[best]
            if (here[1], here[0]) < (champion[1], champion[0]):
                best = position
        order.append(remaining.pop(best)[0])
    return order


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("race").finishing_order

    def test_random_small_races(self):
        rng = random.Random(20260920)
        for _ in range(800):
            size = rng.randint(0, 6)
            names = [rng.choice(NAMES) for _ in range(size)]
            seconds = [rng.choice(TIMES) for _ in range(size)]
            names_before, seconds_before = list(names), list(seconds)
            self.assertEqual(
                self.solve(names, seconds),
                obviously_correct(names_before, seconds_before),
                msg=f"wrong order for names={names_before!r} seconds={seconds_before!r}",
            )
            self.assertEqual(
                (names, seconds),
                (names_before, seconds_before),
                msg=f"an input list was changed: names={names_before!r} "
                f"seconds={seconds_before!r}",
            )

    def test_every_race_of_three_from_two_names_and_two_times(self):
        for first in range(2):
            for second in range(2):
                for third in range(2):
                    for t1 in range(2):
                        for t2 in range(2):
                            for t3 in range(2):
                                names = ["ada" if n else "bob" for n in (first, second, third)]
                                seconds = [10 if t else 20 for t in (t1, t2, t3)]
                                self.assertEqual(
                                    self.solve(list(names), list(seconds)),
                                    obviously_correct(names, seconds),
                                    msg=f"wrong order for names={names!r} seconds={seconds!r}",
                                )


if __name__ == "__main__":
    unittest.main()
