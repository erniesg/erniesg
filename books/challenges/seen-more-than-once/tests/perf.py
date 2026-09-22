"""Perf tier: a month of reads, at the size limit.

One pass over 200,000 plates is two hundredths of a second. Searching the list
for each plate is 40 billion comparisons — minutes at best — and so is keeping
the plates you have seen in a list rather than a set.
"""

import random
import time
import unittest

from bookgrader import load_solution

REPEAT_VISITORS = 50_000
ONE_OFF_VISITORS = 100_000
TIME_LIMIT_SECONDS = 3.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("barrier").count_repeat_visitors

    def test_largest_allowed_log(self):
        rng = random.Random(4242)
        plates = [f"R{n:06d}" for n in range(REPEAT_VISITORS)] * 2
        plates += [f"S{n:06d}" for n in range(ONE_OFF_VISITORS)]
        rng.shuffle(plates)
        self.assertEqual(len(plates), 200_000)

        started = time.perf_counter()
        answer = self.solve(plates)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, REPEAT_VISITORS)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s — "
            f"searching the list for each plate cannot pass here",
        )


if __name__ == "__main__":
    unittest.main()
