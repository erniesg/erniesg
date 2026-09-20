"""ch02 perf tier: n = 300_000 inside the time limit.

The naive double loop needs ~4.5e10 multiplications here — hours. An O(n)
or O(n log n) solution finishes in well under a second.
"""

import random
import unittest

from bookgrader import load_solution

N = 300_000


class PerfTests(unittest.TestCase):
    def setUp(self):
        self.fast = load_solution("pairwise").max_pairwise_product

    def test_huge_input(self):
        # Random bulk stays inside ±150k; planted extremes sit outside it so
        # the expected answer is deterministic.
        rng = random.Random(4242)
        numbers = [rng.randint(-150_000, 150_000) for _ in range(N)]
        numbers[12_345] = 200_000
        numbers[254_321] = 199_999
        numbers[7] = -200_000
        numbers[99_999] = -199_998
        self.assertEqual(self.fast(numbers), 200_000 * 199_999)

    def test_huge_all_negative(self):
        rng = random.Random(777)
        numbers = [rng.randint(-200_000, -2) for _ in range(N)]
        numbers[0] = -200_000
        numbers[-1] = -200_000
        self.assertEqual(self.fast(numbers), 40_000_000_000)


if __name__ == "__main__":
    unittest.main()
