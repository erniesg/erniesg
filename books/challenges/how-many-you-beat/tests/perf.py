"""Perf tier: a season of ascents, at the size limit.

Counting the board and walking the counts is three passes and measures at under
three hundredths of a second. Reading the whole board once per rider is 40
billion comparisons -- twelve minutes measured -- so the tier stops it at
three.

Every time appears exactly twice, so ties are everywhere and an answer that
lets equal times beat each other is out by one place across the whole board.
"""

import random
import time
import unittest

from bookgrader import load_solution

SIZE = 200_000
TIME_LIMIT_SECONDS = 3.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("standings").riders_you_beat

    def test_largest_allowed_board(self):
        rng = random.Random(4242)
        times = [3 * (n // 2) for n in range(SIZE)]
        rng.shuffle(times)
        expected = [2 * (value // 3) for value in times]

        started = time.perf_counter()
        answer = self.solve(times)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, expected)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s -- "
            f"asking the whole board for every rider cannot pass here",
        )


if __name__ == "__main__":
    unittest.main()
