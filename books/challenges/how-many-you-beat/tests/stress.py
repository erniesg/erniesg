"""Stress tier: against the ask-every-rider version, on tiny boards.

The referee below is the answer that cannot finish at full size: for each
entry, read the whole board. On six entries that is 36 comparisons and it
cannot be wrong. Times are drawn from a small range so that ties, zeros and
runs of equal values all turn up within a few tries.
"""

import random
import unittest

from bookgrader import load_solution


def ask_every_rider(times):
    answer = []
    for value in times:
        beaten = 0
        for other in times:
            if other < value:
                beaten += 1
        answer.append(beaten)
    return answer


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("standings").riders_you_beat

    def test_random_tiny_boards(self):
        rng = random.Random(20260920)
        for _ in range(2500):
            times = [rng.randint(0, 4) for _ in range(rng.randint(0, 6))]
            self.assertEqual(
                self.solve(list(times)),
                ask_every_rider(times),
                msg=f"wrong answer for {times!r}",
            )

    def test_every_board_of_four_from_three_times(self):
        for a in range(3):
            for b in range(3):
                for c in range(3):
                    for d in range(3):
                        times = [a, b, c, d]
                        self.assertEqual(
                            self.solve(list(times)),
                            ask_every_rider(times),
                            msg=f"wrong answer for {times!r}",
                        )

    def test_sparse_times_with_big_gaps(self):
        # A time of 1,000,000 next to a time of 0: the chalk has to reach.
        rng = random.Random(4242)
        for _ in range(200):
            times = [rng.choice([0, 1, 999_999, 1_000_000]) for _ in range(rng.randint(1, 8))]
            self.assertEqual(
                self.solve(list(times)),
                ask_every_rider(times),
                msg=f"wrong answer for {times!r}",
            )

    def test_longer_random_boards(self):
        rng = random.Random(777)
        for _ in range(60):
            times = [rng.randint(0, 1_000_000) for _ in range(rng.randint(1, 120))]
            self.assertEqual(
                self.solve(list(times)),
                ask_every_rider(times),
                msg=f"wrong answer for {times!r}",
            )


if __name__ == "__main__":
    unittest.main()
