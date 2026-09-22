"""Perf tier: a full day's log at the stated limit.

200,000 names over 5,000 distinct people. Counting each name by searching the
log again is 200,000 x 200,000 comparisons and will never finish here.
"""

import random
import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 2.0


def name_for(number: int) -> str:
    letters = ""
    number += 1
    while number:
        number, rest = divmod(number - 1, 26)
        letters = chr(ord("a") + rest) + letters
    return letters


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("tally").tally_visits

    def test_full_day_log(self):
        rng = random.Random(20260920)
        people = [name_for(n) for n in range(5_000)]
        log = [rng.choice(people) for _ in range(200_000)]

        started = time.perf_counter()
        result = self.solve(log)
        elapsed = time.perf_counter() - started

        self.assertEqual(sum(result.values()), 200_000)
        self.assertLessEqual(len(result), 5_000)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s — searching the list once per name will not pass",
        )


if __name__ == "__main__":
    unittest.main()
