"""ch02 public tier: visible examples."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.fast = load_solution("pairwise").max_pairwise_product

    def test_examples(self):
        self.assertEqual(self.fast([1, 2, 3]), 6)
        self.assertEqual(self.fast([7, 5, 14, 2, 8, 8, 10, 1, 2, 3]), 140)
        self.assertEqual(self.fast([100_000, 90_000]), 9_000_000_000)


if __name__ == "__main__":
    unittest.main()
