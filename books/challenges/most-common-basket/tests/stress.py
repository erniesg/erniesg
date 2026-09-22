"""Stress tier: against the search-the-log version, on tiny logs.

The referee below is the answer the solution tells you not to write: for every
basket, search the whole log for copies of it. On six baskets that costs
nothing and it cannot be wrong. Items are drawn from three letters so that
repeats and ties turn up within a few tries.
"""

import random
import unittest

from bookgrader import load_solution


def search_the_log(baskets):
    best, best_count = [], -1
    for basket in baskets:
        count = baskets.count(basket)
        if count > best_count:
            best, best_count = basket, count
    return list(best)


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("baskets").most_common_basket

    def test_random_tiny_logs(self):
        rng = random.Random(20260920)
        for _ in range(2000):
            baskets = [
                [rng.choice("abc") for _ in range(rng.randint(0, 2))]
                for _ in range(rng.randint(0, 6))
            ]
            self.assertEqual(
                self.solve([list(b) for b in baskets]),
                search_the_log(baskets),
                msg=f"wrong answer for {baskets!r}",
            )

    def test_every_log_of_three_from_two_baskets(self):
        options = [["a"], ["b"]]
        for first in options:
            for second in options:
                for third in options:
                    baskets = [first, second, third]
                    self.assertEqual(
                        self.solve([list(b) for b in baskets]),
                        search_the_log(baskets),
                        msg=f"wrong answer for {baskets!r}",
                    )

    def test_longer_random_logs(self):
        rng = random.Random(4242)
        for _ in range(60):
            baskets = [
                [rng.choice("abcde") for _ in range(rng.randint(0, 4))]
                for _ in range(rng.randint(1, 80))
            ]
            self.assertEqual(
                self.solve([list(b) for b in baskets]),
                search_the_log(baskets),
                msg=f"wrong answer for {baskets!r}",
            )


if __name__ == "__main__":
    unittest.main()
