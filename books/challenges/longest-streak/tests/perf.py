"""Perf tier: 200,000 days in one pass.

Trying every span of days is correct and hopeless: 200,000 days hold about
twenty billion spans. One walk down the list, one counter.
"""

import random
import time
import unittest

from bookgrader import load_solution

TIME_LIMIT_SECONDS = 1.5
HOW_MANY = 200_000


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("streak").longest_streak

    def test_two_hundred_thousand_days(self):
        rng = random.Random(4242)
        days = [rng.random() < 0.8 for _ in range(HOW_MANY)]
        # Plant one long run that reaches the very last day.
        for position in range(HOW_MANY - 5_000, HOW_MANY):
            days[position] = True
        days[HOW_MANY - 5_001] = False

        started = time.perf_counter()
        answer = self.solve(days)
        elapsed = time.perf_counter() - started

        self.assertGreaterEqual(answer, 5_000, msg="missed the run at the end")
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s for {HOW_MANY} days",
        )

    def test_every_single_day_ticked(self):
        days = [True] * HOW_MANY
        started = time.perf_counter()
        self.assertEqual(self.solve(days), HOW_MANY)
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, TIME_LIMIT_SECONDS, msg=f"took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main()
