"""Stress tier: against the every-pair version, on tiny boards.

The referee below is the answer you were told not to write: subtract every time
from every other. On six ascents that is fifteen subtractions and it cannot be
wrong. Times are drawn from a small range so that dead heats and rider numbers
that disagree with the times both turn up within a few tries.
"""

import random
import unittest

from bookgrader import load_solution


def every_pair(ascents):
    if len(ascents) < 2:
        return -1
    best = None
    for i in range(len(ascents)):
        for j in range(i + 1, len(ascents)):
            gap = abs(ascents[i][1] - ascents[j][1])
            if best is None or gap < best:
                best = gap
    return best


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("timing").closest_ascent

    def test_random_tiny_boards(self):
        rng = random.Random(20260920)
        for _ in range(2500):
            ascents = [
                (rng.randint(1, 4), rng.randint(0, 12))
                for _ in range(rng.randint(0, 6))
            ]
            self.assertEqual(
                self.solve(list(ascents)),
                every_pair(ascents),
                msg=f"wrong answer for {ascents!r}",
            )

    def test_rider_numbers_run_against_the_times(self):
        # Rider numbers counting up while times count down: any answer that
        # orders by rider is wrong here and only here.
        rng = random.Random(777)
        for _ in range(500):
            size = rng.randint(2, 8)
            times = sorted((rng.randint(0, 500) for _ in range(size)), reverse=True)
            ascents = [(n + 1, t) for n, t in enumerate(times)]
            self.assertEqual(
                self.solve(list(ascents)),
                every_pair(ascents),
                msg=f"wrong answer for {ascents!r}",
            )

    def test_longer_random_boards(self):
        rng = random.Random(4242)
        for _ in range(60):
            ascents = [
                (rng.randint(1, 1_000_000), rng.randint(0, 3_000_000))
                for _ in range(rng.randint(2, 120))
            ]
            self.assertEqual(
                self.solve(list(ascents)),
                every_pair(ascents),
                msg=f"wrong answer for {ascents!r}",
            )


if __name__ == "__main__":
    unittest.main()
