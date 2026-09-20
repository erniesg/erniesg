"""Perf tier: a list at the size limit.

Checking every pair cannot finish this in time, however correct it is.
"""

import random
import time
import unittest

from bookgrader import load_solution

SIZE = 200_000
TIME_LIMIT_SECONDS = 5.0


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("pairwise").max_pairwise_product

    def test_largest_allowed_list(self):
        rng = random.Random(4242)
        numbers = [rng.randint(0, 200_000) for _ in range(SIZE)]
        numbers[rng.randrange(SIZE)] = 200_000
        numbers[rng.randrange(SIZE)] = 200_000

        started = time.perf_counter()
        answer = self.solve(numbers)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, 40_000_000_000)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s",
        )


if __name__ == "__main__":
    unittest.main()
