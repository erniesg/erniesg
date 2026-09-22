"""Perf tier: a whole morning of requests against a full parts bin.

100,000 requests, 50,000 parts in the bin. Searching the bin list for each
request is 5 billion comparisons; asking a set is 100,000 lookups.
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
        self.solve = load_solution("stock").missing_items

    def test_a_full_morning(self):
        rng = random.Random(20260920)
        catalogue = [name_for(n) for n in range(60_000)]
        stocked = catalogue[:50_000]
        requested = [rng.choice(catalogue) for _ in range(100_000)]

        started = time.perf_counter()
        answer = self.solve(requested, stocked)
        elapsed = time.perf_counter() - started

        in_bin = set(stocked)
        expected = [n for n in dict.fromkeys(requested) if n not in in_bin]
        self.assertEqual(answer, expected)
        self.assertLess(
            elapsed,
            TIME_LIMIT_SECONDS,
            msg=f"took {elapsed:.2f}s — searching the bin list per request will not pass here",
        )


if __name__ == "__main__":
    unittest.main()
