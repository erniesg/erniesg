"""ch02 stress tier: fast candidate vs slow referee on random inputs.

The referee is an independent double loop implemented here in the test, so
it stays trustworthy even if you edit the naive function in your workspace.
On disagreement, the exact failing input is printed — shrink it by hand
until the bug is obvious.
"""

import random
import unittest

from bookgrader import load_solution

ROUNDS = 400


def referee(numbers: list[int]) -> int:
    best = None
    for i in range(len(numbers)):
        for j in range(i + 1, len(numbers)):
            product = numbers[i] * numbers[j]
            if best is None or product > best:
                best = product
    return best


class StressTests(unittest.TestCase):
    def setUp(self):
        self.fast = load_solution("pairwise").max_pairwise_product

    def test_random_rounds_against_referee(self):
        rng = random.Random(20260721)
        for round_no in range(ROUNDS):
            n = rng.randint(2, 60)
            numbers = [rng.randint(-200_000, 200_000) for _ in range(n)]
            expected = referee(numbers)
            got = self.fast(numbers)
            self.assertEqual(
                got, expected,
                msg=(f"round {round_no}: disagreement on {numbers!r} — "
                     f"fast said {got}, referee said {expected}"),
            )

    def test_small_negative_heavy_rounds(self):
        rng = random.Random(99)
        for round_no in range(ROUNDS):
            n = rng.randint(2, 8)
            numbers = [rng.randint(-10, 3) for _ in range(n)]
            self.assertEqual(
                self.fast(numbers), referee(numbers),
                msg=f"negative-heavy round {round_no}: input {numbers!r}",
            )


if __name__ == "__main__":
    unittest.main()
