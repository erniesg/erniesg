"""Perf tier: a race at the size limit.

Ordering 200,000 swimmers costs a few million comparisons. Reading the order
out by hand — pick the fastest left, cross it off, repeat — costs 20 billion,
and does not finish here.
"""

import random
import time
import unittest

from bookgrader import load_solution

SIZE = 200_000
TIME_LIMIT_SECONDS = 3.0

ALPHABET = "abcdefghijklmnopqrstuvwxyz"


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("race").finishing_order

    def test_largest_allowed_race(self):
        rng = random.Random(4242)
        names = ["".join(rng.choice(ALPHABET) for _ in range(6)) for _ in range(SIZE)]
        seconds = [rng.randint(0, 1_000_000) for _ in range(SIZE)]
        expected = [
            name for name, _ in sorted(zip(names, seconds), key=lambda p: (p[1], p[0]))
        ]

        started = time.perf_counter()
        answer = self.solve(names, seconds)
        elapsed = time.perf_counter() - started

        self.assertEqual(answer, expected)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s, limit is {TIME_LIMIT_SECONDS}s",
        )


if __name__ == "__main__":
    unittest.main()
