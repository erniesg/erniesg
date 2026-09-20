"""Perf tier: a year of bank lines, at the size limit.

One pass over 200,000 lines, asking a set for the missing half, takes about two
hundredths of a second. Every line against every earlier line is 20 billion
additions -- nine minutes measured -- so the tier stops it at three seconds.

The filler amounts are all multiples of ten and the target ends in a 5, so no
two filler lines can possibly add up to it. The only pair in the file is the
one planted at positions 7 and 199,999, which makes the answer the very last
line and denies the every-pair version any chance of an early exit.
"""

import random
import time
import unittest

from bookgrader import load_solution

SIZE = 200_000
TARGET = 1_234_565
FIRST_HALF = 617_282
SECOND_HALF = 617_283
TIME_LIMIT_SECONDS = 3.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("balance").first_balancing_line

    def test_largest_allowed_file(self):
        rng = random.Random(4242)
        amounts = [rng.randrange(-100_000, 100_001) * 10 for _ in range(SIZE)]
        amounts[7] = FIRST_HALF
        amounts[SIZE - 1] = SECOND_HALF
        self.assertEqual(FIRST_HALF + SECOND_HALF, TARGET)

        started = time.perf_counter()
        answer = self.solve(amounts, TARGET)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, SIZE - 1)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s -- "
            f"an every-pair answer cannot pass here",
        )

    def test_largest_allowed_file_with_no_pair_at_all(self):
        rng = random.Random(99)
        amounts = [rng.randrange(-100_000, 100_001) * 10 for _ in range(SIZE)]

        started = time.perf_counter()
        answer = self.solve(amounts, TARGET)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, -1)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s",
        )


if __name__ == "__main__":
    unittest.main()
