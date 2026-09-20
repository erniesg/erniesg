"""ch02 edge tier: the cases that kill "take the two largest"."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.fast = load_solution("pairwise").max_pairwise_product

    def test_two_most_negative_can_win(self):
        self.assertEqual(self.fast([-9, -8, 1, 2]), 72)
        self.assertEqual(self.fast([-200_000, -200_000, 1]), 40_000_000_000)

    def test_all_negative(self):
        self.assertEqual(self.fast([-3, -1, -2]), 6)  # (-3) * (-2)

    def test_minimum_length_two(self):
        self.assertEqual(self.fast([2, 3]), 6)
        self.assertEqual(self.fast([-2, 3]), -6)

    def test_duplicates_of_the_maximum(self):
        self.assertEqual(self.fast([5, 5]), 25)
        self.assertEqual(self.fast([0, 5, 5]), 25)

    def test_zeros(self):
        self.assertEqual(self.fast([0, 0]), 0)
        self.assertEqual(self.fast([-4, 0, -3]), 12)
        self.assertEqual(self.fast([-4, 0, 3]), 0)

    def test_max_constraint_values(self):
        self.assertEqual(self.fast([200_000, 200_000]), 40_000_000_000)


if __name__ == "__main__":
    unittest.main()
