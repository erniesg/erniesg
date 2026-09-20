"""Edge tier: the smallest and largest legal shapes, and repeated values."""

import unittest

from bookgrader import load_solution


class EdgeTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("pairwise").max_pairwise_product

    def test_smallest_list(self):
        self.assertEqual(self.solve([0, 0]), 0)
        self.assertEqual(self.solve([1, 1]), 1)

    def test_every_value_identical(self):
        self.assertEqual(self.solve([7] * 50), 49)

    def test_largest_values_allowed(self):
        self.assertEqual(self.solve([200_000, 200_000]), 40_000_000_000)
        self.assertEqual(self.solve([200_000, 199_999, 3]), 39_999_800_000)

    def test_biggest_value_appears_twice(self):
        # The trap: removing every copy of the maximum loses the answer.
        self.assertEqual(self.solve([5, 5, 1]), 25)
        self.assertEqual(self.solve([0, 9, 9, 0]), 81)

    def test_zeros_dominate(self):
        self.assertEqual(self.solve([0, 0, 0]), 0)


if __name__ == "__main__":
    unittest.main()
