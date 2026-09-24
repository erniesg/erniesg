"""Public tier: the examples printed in the statement."""

import unittest

from bookgrader import load_solution


class PublicTests(unittest.TestCase):
    def setUp(self):
        self.solve = load_solution("pairwise").max_pairwise_product

    def test_statement_samples(self):
        self.assertEqual(self.solve([1, 2, 3]), 6)
        self.assertEqual(self.solve([0, 0, 7]), 0)


if __name__ == "__main__":
    unittest.main()
