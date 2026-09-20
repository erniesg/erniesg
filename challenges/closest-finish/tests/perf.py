"""Perf tier: twenty years of ascents, at the size limit.

One sort of 200,000 times plus one walk over the neighbours takes about four
hundredths of a second. Every ascent against every other is 20 billion
subtractions -- sixteen minutes measured -- so the tier stops it at three.

The board is built so that no two times are equal and every gap is 15
hundredths, except for one planted ascent four hundredths away from its
neighbour. So the answer is 4, a shortcut that only hunts for dead heats
reports the wrong thing, and an answer that orders by rider number is nowhere
near.
"""

import random
import time
import unittest

from bookgrader import load_solution

SPACING = 15
FILLERS = 199_999
PLANTED = 1_000 * SPACING + 4
TIME_LIMIT_SECONDS = 3.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("timing").closest_ascent

    def test_largest_allowed_board(self):
        rng = random.Random(4242)
        times = [n * SPACING for n in range(FILLERS)] + [PLANTED]
        rng.shuffle(times)
        riders = list(range(1, len(times) + 1))
        rng.shuffle(riders)
        ascents = list(zip(riders, times))
        self.assertEqual(len(ascents), 200_000)
        self.assertEqual(len(set(times)), 200_000, msg="the board should hold no dead heats")

        started = time.perf_counter()
        answer = self.solve(ascents)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, 4)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s -- "
            f"an every-pair answer cannot pass here",
        )


if __name__ == "__main__":
    unittest.main()
