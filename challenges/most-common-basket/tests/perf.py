"""Perf tier: a week of baskets, at the size limit.

One pass over 196,060 baskets, counting frozen copies in a dict, takes a few
hundredths of a second. Counting each basket by searching the log for it is
196,060 x 196,060 basket comparisons -- over five minutes measured -- so the
tier stops it at three seconds.
"""

import random
import time
import unittest

from bookgrader import load_solution

DISTINCT_BASKETS = 4_000
TIMES_EACH = 49
WINNER_APPEARS = 60
TIME_LIMIT_SECONDS = 3.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("baskets").most_common_basket

    def test_largest_allowed_log(self):
        rng = random.Random(4242)
        winner = ["milk", "bread"]
        baskets = [winner[:] for _ in range(WINNER_APPEARS)]
        for n in range(DISTINCT_BASKETS):
            one = [f"aisle{n % 20}", f"item{n:05d}"]
            baskets += [one[:] for _ in range(TIMES_EACH)]
        rng.shuffle(baskets)
        self.assertEqual(len(baskets), DISTINCT_BASKETS * TIMES_EACH + WINNER_APPEARS)

        started = time.perf_counter()
        answer = self.solve(baskets)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, winner)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s -- "
            f"counting a basket by searching the log cannot pass here",
        )


if __name__ == "__main__":
    unittest.main()
