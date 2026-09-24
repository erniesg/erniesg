"""Stress tier: against the count-them-by-searching version, on tiny lists.

The referee below is the slow answer: for each plate, search the whole list
and count the matches. On eight reads that is 64 comparisons and it cannot be
wrong. Plates are drawn from four possibilities so that repeats — and triples,
and quadruples — happen constantly.
"""

import random
import unittest

from bookgrader import load_solution

PLATES = ["AB1", "CD2", "EF3", "GH4"]


def by_searching(plates):
    repeats = 0
    counted = []
    for plate in plates:
        if plate in counted:
            continue
        counted.append(plate)
        times = 0
        for other in plates:
            if other == plate:
                times += 1
        if times > 1:
            repeats += 1
    return repeats


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("barrier").count_repeat_visitors

    def test_random_tiny_logs(self):
        rng = random.Random(20260920)
        for _ in range(1500):
            plates = [rng.choice(PLATES) for _ in range(rng.randint(0, 8))]
            self.assertEqual(
                self.solve(list(plates)),
                by_searching(plates),
                msg=f"wrong answer for {plates!r}",
            )

    def test_every_log_of_four_reads_from_three_plates(self):
        for a in PLATES[:3]:
            for b in PLATES[:3]:
                for c in PLATES[:3]:
                    for d in PLATES[:3]:
                        plates = [a, b, c, d]
                        self.assertEqual(
                            self.solve(list(plates)),
                            by_searching(plates),
                            msg=f"wrong answer for {plates!r}",
                        )

    def test_random_logs_with_many_plates(self):
        rng = random.Random(4242)
        for _ in range(200):
            pool = [f"P{n}" for n in range(rng.randint(1, 12))]
            plates = [rng.choice(pool) for _ in range(rng.randint(0, 30))]
            self.assertEqual(
                self.solve(list(plates)),
                by_searching(plates),
                msg=f"wrong answer for {plates!r}",
            )


if __name__ == "__main__":
    unittest.main()
