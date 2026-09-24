"""Stress tier: against trying every length, on piles small enough to do by hand.

The referee below is the answer you were told not to write: try 1 mm, then
2 mm, then 3 mm, and keep the longest that filled the order. On a pile of
five short ends it costs nothing and it cannot be wrong. Lengths are drawn
from a small range so that ties, impossible orders and single-piece piles all
turn up within a few tries.
"""

import random
import unittest

from bookgrader import load_solution


def try_every_length(pieces, wanted):
    best = 0
    for length in range(1, max(pieces, default=0) + 1):
        if sum(piece // length for piece in pieces) >= wanted:
            best = length
    return best


class StressTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("cable").longest_lead

    def test_random_tiny_piles(self):
        rng = random.Random(20260920)
        for _ in range(1500):
            pieces = [rng.randint(1, 12) for _ in range(rng.randint(0, 5))]
            wanted = rng.randint(1, 14)
            self.assertEqual(
                self.solve(list(pieces), wanted),
                try_every_length(pieces, wanted),
                msg=f"wrong answer for {pieces!r}, order of {wanted}",
            )

    def test_every_order_for_every_small_pile(self):
        for a in range(1, 7):
            for b in range(1, 7):
                for c in range(1, 7):
                    pieces = [a, b, c]
                    for wanted in range(1, 19):
                        self.assertEqual(
                            self.solve(list(pieces), wanted),
                            try_every_length(pieces, wanted),
                            msg=f"wrong answer for {pieces!r}, order of {wanted}",
                        )

    def test_longer_random_piles(self):
        rng = random.Random(4242)
        for _ in range(40):
            pieces = [rng.randint(1, 400) for _ in range(rng.randint(1, 60))]
            wanted = rng.randint(1, 900)
            self.assertEqual(
                self.solve(list(pieces), wanted),
                try_every_length(pieces, wanted),
                msg=f"wrong answer for an order of {wanted}",
            )


if __name__ == "__main__":
    unittest.main()
